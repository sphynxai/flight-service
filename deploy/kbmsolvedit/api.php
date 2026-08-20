<?php
// Flight Service briefing API — PHP port for kbmsolvedit.net (shared host, no Node).
//
// Mirrors src/weather-fetcher.js, src/winds-fetcher.js and src/briefing-agent.js.
// The browser cannot call NOAA directly (aviationweather.gov sends no CORS
// header), so this endpoint does the fetching server-side.
//
// No ANTHROPIC_API_KEY lives on this host by design, so this always renders the
// deterministic fallback briefing — same output the Node app produces without a
// key. Do not add a key here; it is a shared public host.

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

const NOAA_API   = 'https://aviationweather.gov/api/data';
const FB_REGIONS = ['bos', 'chi', 'dfw', 'mia', 'slc', 'sfo'];
const FB_CACHE   = __DIR__ . '/fb_cache.php'; // .php + exit guard: never served as data
const FB_TTL     = 3600;

// Fixed column offsets, [start, length]. See the JS twin for why this must not
// be whitespace-split: high-elevation stations omit low levels, so DEN's row
// begins at the 9,000 ft column.
const LEVEL_COLUMNS = [
    3000  => [4, 4],
    6000  => [9, 7],
    9000  => [17, 7],
    12000 => [25, 7],
    18000 => [33, 7],
    24000 => [41, 7],
    30000 => [49, 6],
    34000 => [56, 6],
    39000 => [63, 6],
];

// FB station IDs are not ICAO. Most drop the leading K; a few busy airports have
// no FB station and are represented by another field in the metro. Substitutions
// are surfaced in the response so the reader sees which station was used.
// Nearest FB station where the airport has none of its own. Surfaced in the UI
// as "nearest available" so the substitution is visible.
const ICAO_TO_FB = [
    'KDFW' => 'DAL', // ~15 nm
    'KDTO' => 'DAL', // Denton Enterprise, ~30 nm
    'KADS' => 'DAL', // Addison, ~10 nm
    'KFTW' => 'DAL', // Meacham, ~25 nm
    'KAFW' => 'DAL', // Fort Worth Alliance, ~30 nm
];

function fail(int $code, string $msg): void {
    http_response_code($code);
    echo json_encode(['error' => $msg]);
    exit;
}

function fetch_all(array $urls, bool $retry = true): array {
    $mh = curl_multi_init();
    $handles = [];
    foreach ($urls as $key => $url) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 12,
            CURLOPT_CONNECTTIMEOUT => 6,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_USERAGENT      => 'flight-service/0.1 (+kbmsolvedit.net)',
        ]);
        curl_multi_add_handle($mh, $ch);
        $handles[$key] = $ch;
    }

    $running = null;
    do {
        curl_multi_exec($mh, $running);
        if ($running) curl_multi_select($mh, 1.0);
    } while ($running > 0);

    $out = [];
    foreach ($handles as $key => $ch) {
        $body = curl_multi_getcontent($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $out[$key] = ($code === 200 && is_string($body)) ? $body : null;
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
    }
    curl_multi_close($mh);

    // One retry for anything that dropped. A briefing makes ~14 outbound calls;
    // a single lost METAR does not just blank one station, it nulls the route
    // geometry and silently widens the enroute corridor. Observed live.
    if ($retry) {
        $missing = [];
        foreach ($out as $k => $v) if ($v === null) $missing[$k] = $urls[$k];
        if ($missing) {
            usleep(400000);
            foreach (fetch_all($missing, false) as $k => $v) {
                if ($v !== null) $out[$k] = $v;
            }
        }
    }

    return $out;
}

/** Decode one FB group. Returns null when unparseable. */
function fb_parse_group(string $text): ?array {
    $g = trim($text);
    if (strlen($g) < 4) return null;

    $dd = substr($g, 0, 2);
    $ff = substr($g, 2, 2);

    $lightVariable = ($dd === '99' && $ff === '00');
    $dir = null;
    $speed = null;

    if (!$lightVariable) {
        if (!ctype_digit($dd) || !ctype_digit($ff)) return null;
        $d = (int)$dd;
        $s = (int)$ff;
        // Direction 51-86 encodes wind >= 100 kt.
        if ($d >= 51 && $d <= 86) { $d -= 50; $s += 100; }
        $dir = $d * 10;
        $speed = $s;
        // Valid dd is 01-36, 51-86 or 99; anything else is an impossible bearing.
        if ($dir > 360) return null;
    }

    // Temp is signed at/below 24,000 ft, unsigned and always negative above.
    // An empty tail is legitimate (the 3,000 ft column carries no temp); anything
    // else non-numeric means the group is malformed and is not trusted at all.
    $temp = null;
    $tp = substr($g, 4);
    if ($tp !== '' && $tp !== false) {
        if (!preg_match('/^[+-]?\d+$/', $tp)) return null;
        $n = (int)str_replace('+', '', $tp);
        $temp = (strpos($tp, '+') === 0) ? $n : -abs($n);
    }

    return ['dir' => $dir, 'speed' => $speed, 'temp' => $temp,
            'lightVariable' => $lightVariable, 'raw' => $g];
}

/**
 * Split one station row by fixed column offsets. This is where a
 * whitespace-split would go wrong on stations that omit low levels.
 */
function fb_parse_station_line(string $line): ?array {
    $id = trim(substr($line, 0, 3));
    if (!preg_match('/^[A-Z0-9]{3}$/', $id)) return null;

    $levels = [];
    foreach (LEVEL_COLUMNS as $ft => [$start, $len]) {
        $g = fb_parse_group(substr($line, $start, $len));
        if ($g) $levels[$ft] = $g;
    }
    return $levels ? ['id' => $id, 'levels' => $levels] : null;
}

function fb_table(): array {
    if (is_readable(FB_CACHE)) {
        $blob = file_get_contents(FB_CACHE);
        $nl = strpos($blob, "\n");
        if ($nl !== false) {
            $cached = json_decode(substr($blob, $nl + 1), true);
            if (is_array($cached) && (time() - ($cached['ts'] ?? 0)) < FB_TTL) {
                return $cached['data'];
            }
        }
    }

    $urls = [];
    foreach (FB_REGIONS as $r) {
        $urls[$r] = NOAA_API . '/windtemp?region=' . $r . '&fcst=06&level=low';
    }
    $bodies = fetch_all($urls);

    $stations = [];
    $validity = null;
    foreach ($bodies as $body) {
        if (!$body) continue;
        foreach (explode("\n", $body) as $line) {
            if ($validity === null && strpos($line, 'VALID') === 0) {
                $validity = trim($line);
            }
            $parsed = fb_parse_station_line($line);
            if ($parsed) $stations[$parsed['id']] = $parsed['levels'];
        }
    }

    $data = ['stations' => $stations, 'validity' => $validity];

    // .php + exit guard so the cache is never readable over HTTP (this host
    // ignores .htaccess entirely).
    @file_put_contents(
        FB_CACHE,
        "<?php exit; ?>\n" . json_encode(['ts' => time(), 'data' => $data])
    );

    return $data;
}

function nearest_level($altitude): int {
    $alt = (int)$altitude;
    if ($alt <= 0) return 30000;
    $best = 30000;
    foreach (array_keys(LEVEL_COLUMNS) as $ft) {
        if (abs($ft - $alt) < abs($best - $alt)) $best = $ft;
    }
    return $best;
}

function winds_for(string $icao, $altitude, array $table): array {
    $fbId = ICAO_TO_FB[$icao] ?? (strlen($icao) === 4 && $icao[0] === 'K' ? substr($icao, 1) : $icao);

    if (!isset($table['stations'][$fbId])) {
        return ['airport' => $icao, 'available' => false,
                'reason' => 'no FB station for this airport'];
    }

    $level = nearest_level($altitude);
    if (!isset($table['stations'][$fbId][$level])) {
        return ['airport' => $icao, 'station' => $fbId, 'available' => false,
                'reason' => "no " . number_format($level) . " ft forecast for station $fbId"];
    }

    $w = $table['stations'][$fbId][$level];
    return [
        'airport' => $icao,
        'station' => $fbId,
        'substituted' => isset(ICAO_TO_FB[$icao]),
        'available' => true,
        'level' => $level,
        'requestedAltitude' => (int)$altitude ?: null,
        'dir' => $w['dir'],
        'speed' => $w['speed'],
        'temp' => $w['temp'],
        'lightVariable' => $w['lightVariable'],
        'raw' => $w['raw'],
        'validity' => $table['validity'],
    ];
}

/**
 * Pressure and density altitude — mirror of computeAltitudes() in
 * src/weather-fetcher.js. Moist-air (virtual temperature) method, not the dry
 * rule of thumb: the dry form ignores humidity and understates density
 * altitude, which is the dangerous direction. Validated against Garmin Pilot's
 * published KULM/KLUM figures to within 25 ft.
 */
function compute_altitudes($elev, $temp, $dewp, $altim): array {
    if ($elev === null || $temp === null || $altim === null) {
        return ['pressureAltitude' => null, 'densityAltitude' => null];
    }

    $elevFt = $elev * 3.280839895;

    // NOAA reports altim in hPa already; pressure altitude works in inHg.
    $altimHpa = $altim;
    $altimInHg = $altim / 33.8639;
    $pa = $elevFt + (29.92 - $altimInHg) * 1000.0;

    // Without a dewpoint fall back to dry air rather than inventing humidity.
    $td = $dewp === null ? $temp : $dewp;

    $pSta = $altimHpa * pow((288.15 - 0.0065 * $elev) / 288.15, 5.2558797);
    $e = 6.112 * exp((17.67 * $td) / ($td + 243.5));
    $tv = ($temp + 273.15) / (1.0 - 0.378 * $e / $pSta);
    $rho = ($pSta * 100.0) / (287.05 * $tv);
    $da = 145442.16 * (1.0 - pow($rho / 1.225, 0.234969));

    return [
        'pressureAltitude' => (int)round($pa),
        'densityAltitude'  => (int)round($da),
    ];
}

// ------------------------------------------------- adverse conditions ------
// Mirror of src/hazards-fetcher.js. Filtering is deliberately permissive: a
// hazard is included when its bounding box overlaps the padded route box.
// Showing an off-route SIGMET is an annoyance; hiding an on-route one is a
// safety failure.

const CORRIDOR_NM = 100;
const NM_PER_DEG_LAT = 60;

function h_num($v) {
    if ($v === null || $v === '') return null;
    $n = is_numeric($v) ? (float)$v : NAN;
    return is_nan($n) ? null : $n;
}

/**
 * G-AIRMET altitudes are in HUNDREDS OF FEET and the base may be a keyword.
 *   240 -> 24,000 ft (NOT 240 ft) | "SFC" -> surface | "FZL" -> freezing level
 * Reading these literally turns an icing layer topping FL240 into "240 ft".
 */
function gairmet_altitude($v): ?array {
    if ($v === null || $v === '') return null;

    $s = strtoupper(trim((string)$v));
    if ($s === 'SFC') return ['ft' => 0, 'label' => 'surface'];
    if ($s === 'FZL') return ['ft' => null, 'label' => 'freezing level'];

    if (!is_numeric($s)) return null;
    $ft = (int)round((float)$s * 100);
    return ['ft' => $ft, 'label' => number_format($ft) . 'ft'];
}

function coords_bounds($coords): ?array {
    if (!is_array($coords) || !$coords) return null;

    $minLat = INF; $maxLat = -INF; $minLon = INF; $maxLon = -INF; $seen = 0;
    foreach ($coords as $c) {
        $lat = h_num($c['lat'] ?? null);
        $lon = h_num($c['lon'] ?? null);
        if ($lat === null || $lon === null) continue;
        $seen++;
        $minLat = min($minLat, $lat); $maxLat = max($maxLat, $lat);
        $minLon = min($minLon, $lon); $maxLon = max($maxLon, $lon);
    }
    if (!$seen) return null;
    return ['minLat' => $minLat, 'maxLat' => $maxLat, 'minLon' => $minLon, 'maxLon' => $maxLon];
}

function route_bounds(array $points, float $padNm = CORRIDOR_NM): ?array {
    $usable = [];
    foreach ($points as $p) {
        $lat = h_num($p['lat'] ?? null);
        $lon = h_num($p['lon'] ?? null);
        if ($lat !== null && $lon !== null) $usable[] = ['lat' => $lat, 'lon' => $lon];
    }
    if (!$usable) return null;

    $b = coords_bounds($usable);
    $midLat = ($b['minLat'] + $b['maxLat']) / 2;
    $padLat = $padNm / NM_PER_DEG_LAT;
    // Longitude degrees shrink with latitude; guard the cosine near the poles.
    $cos = max(cos(deg2rad($midLat)), 0.01);
    $padLon = $padNm / (NM_PER_DEG_LAT * $cos);

    return [
        'minLat' => $b['minLat'] - $padLat, 'maxLat' => $b['maxLat'] + $padLat,
        'minLon' => $b['minLon'] - $padLon, 'maxLon' => $b['maxLon'] + $padLon,
    ];
}

/** Great-circle distance in nm between two ['lat'=>,'lon'=>]. */
function distance_nm(?array $a, ?array $b): ?float {
    foreach ([$a, $b] as $p) {
        if (!$p || !is_numeric($p['lat'] ?? null) || !is_numeric($p['lon'] ?? null)) return null;
    }
    $la1 = deg2rad((float)$a['lat']); $la2 = deg2rad((float)$b['lat']);
    $dLat = $la2 - $la1;
    $dLon = deg2rad((float)$b['lon'] - (float)$a['lon']);
    $h = sin($dLat / 2) ** 2 + cos($la1) * cos($la2) * sin($dLon / 2) ** 2;
    return 2 * asin(min(1, sqrt($h))) * 3440.065;
}

/**
 * Should the reported position widen the route box?
 *
 * Only when the pilot is near the flight. Planning a Texas departure from a desk
 * in Los Angeles is 1,200 nm away — folding that in stretches the box across the
 * continent and fills the briefing with irrelevant West Coast hazards.
 */
function position_is_on_route(?array $pos, array $endpoints, float $maxNm = 250): bool {
    $d = [];
    foreach ($endpoints as $e) {
        $x = distance_nm($pos, $e);
        if ($x !== null) $d[] = $x;
    }
    return $d ? min($d) <= $maxNm : false;
}

function bounds_intersect(?array $a, ?array $b): bool {
    if (!$a || !$b) return false;
    return $a['minLat'] <= $b['maxLat'] && $a['maxLat'] >= $b['minLat']
        && $a['minLon'] <= $b['maxLon'] && $a['maxLon'] >= $b['minLon'];
}

/** No geometry means it cannot be proven off-route, so it is kept. */
function on_route($coords, array $bounds): bool {
    $hb = coords_bounds($coords);
    if (!$hb) return true;
    return bounds_intersect($hb, $bounds);
}

function map_airsigmet(array $x): array {
    return [
        'type' => $x['airSigmetType'] ?? null,
        'hazard' => $x['hazard'] ?? null,
        'severity' => $x['severity'] ?? null,
        'altitudeLow' => h_num($x['altitudeLow1'] ?? null),
        'altitudeHigh' => h_num($x['altitudeHi1'] ?? null),
        'raw' => trim((string)($x['rawAirSigmet'] ?? '')) ?: null,
    ];
}

function fetch_hazards(array $points): array {
    $bounds = route_bounds($points);
    if (!$bounds) {
        return ['available' => false, 'reason' => 'no usable coordinates for the route',
                'corridorNm' => CORRIDOR_NM, 'convectiveSigmets' => [], 'sigmets' => [],
                'gairmets' => [], 'cwas' => []];
    }

    // PIREPs are queried by bounding box rather than filtered client-side.
    $bbox = implode(',', [
        number_format($bounds['minLat'], 3, '.', ''), number_format($bounds['minLon'], 3, '.', ''),
        number_format($bounds['maxLat'], 3, '.', ''), number_format($bounds['maxLon'], 3, '.', ''),
    ]);

    $bodies = fetch_all([
        'airsigmet' => NOAA_API . '/airsigmet?format=json',
        'gairmet'   => NOAA_API . '/gairmet?format=json',
        'cwa'       => NOAA_API . '/cwa?format=json',
        'pirep'     => NOAA_API . '/pirep?bbox=' . urlencode($bbox) . '&format=json',
    ]);

    $decode = function (?string $b): ?array {
        if ($b === null) return null;
        $d = json_decode($b, true);
        return is_array($d) ? $d : null;
    };

    $airsig = $decode($bodies['airsigmet']);
    $gair   = $decode($bodies['gairmet']);
    $cwa    = $decode($bodies['cwa']);
    $pirep  = $decode($bodies['pirep']);

    // A failed source must not read as "nothing out there".
    $failed = [];
    if ($airsig === null) $failed[] = 'SIGMET';
    if ($gair === null)   $failed[] = 'G-AIRMET';
    if ($cwa === null)    $failed[] = 'CWA';
    if ($pirep === null)  $failed[] = 'PIREP';

    $now = time();
    $near = function (?array $arr) use ($bounds, $now): array {
        $out = [];
        foreach ($arr ?? [] as $x) {
            $to = h_num($x['validTimeTo'] ?? $x['expireTime'] ?? null);
            if ($to !== null && $to < $now - 60) continue; // expired
            if (!on_route($x['coords'] ?? null, $bounds)) continue;
            $out[] = $x;
        }
        return $out;
    };

    $airNear = $near($airsig);
    $conv = []; $sig = [];
    foreach ($airNear as $x) {
        if (strtoupper((string)($x['hazard'] ?? '')) === 'CONVECTIVE') $conv[] = map_airsigmet($x);
        else $sig[] = map_airsigmet($x);
    }

    $gairmets = [];
    foreach ($near($gair) as $g) {
        $gairmets[] = [
            'hazard' => $g['hazard'] ?? null,
            'severity' => $g['severity'] ?? null,
            'base' => gairmet_altitude($g['base'] ?? null),
            'top' => gairmet_altitude($g['top'] ?? null),
            'level' => gairmet_altitude($g['level'] ?? null),
        ];
    }

    $cwas = [];
    foreach ($near($cwa) as $c) {
        $cwas[] = ['cwsu' => $c['cwsu'] ?? null, 'name' => $c['name'] ?? null,
                   'hazard' => $c['hazard'] ?? null];
    }

    // fltLvl is in hundreds of feet (verified: fltLvl 350 carries "/FL350/").
    // airepType comes back null in practice, so urgency is read from the raw
    // UUA token instead.
    $pireps = [];
    foreach ($pirep ?? [] as $p) {
        $raw = trim((string)($p['rawOb'] ?? ''));
        $pireps[] = [
            'urgent' => (bool)preg_match('/\bUUA\b/', $raw),
            'acType' => $p['acType'] ?? null,
            'flightLevel' => isset($p['fltLvl']) && $p['fltLvl'] !== null
                ? (int)((float)$p['fltLvl'] * 100) : null,
            'raw' => $raw ?: null,
        ];
    }
    usort($pireps, fn($a, $b) => ($b['urgent'] ? 1 : 0) <=> ($a['urgent'] ? 1 : 0));

    return [
        'available' => true,
        'corridorNm' => CORRIDOR_NM,
        'bounds' => $bounds,
        'partial' => $failed ?: null,
        'convectiveSigmets' => $conv,
        'sigmets' => $sig,
        'gairmets' => $gairmets,
        'pireps' => $pireps,
        'cwas' => $cwas,
    ];
}

function h_ft($n): ?string {
    return $n === null ? null : number_format((float)$n) . 'ft';
}

function describe_hazards(?array $h): string {
    if (!$h || empty($h['available'])) {
        return 'Adverse conditions not checked (' . ($h['reason'] ?? 'no data') . ')';
    }

    $lines = [];

    $band = function ($lo, $hi): string {
        $a = h_ft($lo); $b = h_ft($hi);
        if ($a && $b) return " $a–$b";
        if ($b) return " up to $b";
        if ($a) return " above $a";
        return '';
    };

    foreach ($h['convectiveSigmets'] as $s) {
        $first = 'Convective SIGMET';
        foreach (explode("\n", (string)$s['raw']) as $l) {
            if (strpos($l, 'CONVECTIVE SIGMET') !== false) { $first = trim($l); break; }
        }
        $lines[] = "• CONVECTIVE SIGMET — $first" . $band($s['altitudeLow'], $s['altitudeHigh']);
    }

    foreach ($h['sigmets'] as $s) {
        $sev = $s['severity'] !== null ? " (severity {$s['severity']})" : '';
        $lines[] = rtrim("• SIGMET " . ($s['hazard'] ?? '')) . $sev
                 . $band($s['altitudeLow'], $s['altitudeHigh']);
    }

    // Collapse per-forecast-hour G-AIRMETs; take the widest band so the summary
    // cannot understate the extent.
    $byHazard = [];
    foreach ($h['gairmets'] as $g) {
        $byHazard[$g['hazard'] ?? 'UNKNOWN'][] = $g;
    }
    foreach ($byHazard as $hazard => $list) {
        $tops = []; $levels = []; $baseLabels = [];
        foreach ($list as $g) {
            if (($g['top']['ft'] ?? null) !== null) $tops[] = $g['top']['ft'];
            if (($g['level']['ft'] ?? null) !== null) $levels[] = $g['level']['ft'];
            if (($g['base']['label'] ?? null) !== null) $baseLabels[$g['base']['label']] = true;
        }
        $extent = '';
        if ($tops) {
            $base = count($baseLabels) === 1 ? array_key_first($baseLabels) : null;
            $extent = $base ? ' ' . $base . ' to ' . h_ft(max($tops)) : ' to ' . h_ft(max($tops));
        } elseif ($levels) {
            $lo = min($levels); $hi = max($levels);
            $extent = $lo === $hi ? ' at ' . h_ft($lo) : ' ' . h_ft($lo) . '–' . h_ft($hi);
        }
        $n = count($list);
        $lines[] = "• G-AIRMET $hazard$extent ($n period" . ($n > 1 ? 's' : '') . ')';
    }

    foreach ($h['cwas'] as $c) {
        $lines[] = rtrim('• Center Weather Advisory — ' . ($c['name'] ?? $c['cwsu'] ?? '')
                 . ' ' . ($c['hazard'] ?? ''));
    }

    // Pilot reports last: observations rather than advisories, but an urgent
    // one (UUA) outranks everything above it.
    $pireps = $h['pireps'] ?? [];
    foreach (array_slice($pireps, 0, 6) as $p) {
        $fl = $p['flightLevel'] !== null ? ' ' . h_ft($p['flightLevel']) : '';
        $lines[] = rtrim(($p['urgent'] ? '• URGENT PIREP' : '• PIREP') . $fl
                 . ' — ' . ($p['raw'] ?? $p['acType'] ?? ''));
    }
    if (count($pireps) > 6) {
        $n = count($pireps) - 6;
        $lines[] = '  …and ' . $n . ' more pilot report' . ($n > 1 ? 's' : '') . ' on route.';
    }

    if (!$lines) {
        $lines[] = "No SIGMETs, G-AIRMETs or Center Weather Advisories within {$h['corridorNm']}nm of the route.";
    }
    if (!empty($h['partial'])) {
        $lines[] = '⚠ ' . implode(' and ', $h['partial']) . ' source unavailable — this list may be incomplete.';
    }

    return implode("\n", $lines);
}

// ------------------------------------------------------ enroute stations ---

const EARTH_NM = 3440.065;

function ang_dist(array $a, array $b): float {
    $dLat = deg2rad((float)$b['lat'] - (float)$a['lat']);
    $dLon = deg2rad((float)$b['lon'] - (float)$a['lon']);
    $la1 = deg2rad((float)$a['lat']); $la2 = deg2rad((float)$b['lat']);
    $h = sin($dLat / 2) ** 2 + cos($la1) * cos($la2) * sin($dLon / 2) ** 2;
    return 2 * asin(min(1, sqrt($h)));
}

function bearing_rad(array $a, array $b): float {
    $la1 = deg2rad((float)$a['lat']); $la2 = deg2rad((float)$b['lat']);
    $dLon = deg2rad((float)$b['lon'] - (float)$a['lon']);
    $y = sin($dLon) * cos($la2);
    $x = cos($la1) * sin($la2) - sin($la1) * cos($la2) * cos($dLon);
    return atan2($y, $x);
}

/**
 * Perpendicular distance in nm from a point to the great-circle track.
 * A bounding box is not a corridor — the KDFW-KMSP box spans Texas to
 * Minnesota, so Shreveport falls inside it while being far off route.
 */
function cross_track_nm(?array $from, ?array $to, ?array $p): ?float {
    foreach ([$from, $to, $p] as $x) {
        if (!$x || !is_numeric($x['lat'] ?? null) || !is_numeric($x['lon'] ?? null)) return null;
    }
    $xt = asin(sin(ang_dist($from, $p)) * sin(bearing_rad($from, $p) - bearing_rad($from, $to))) * EARTH_NM;
    return abs($xt);
}

function fetch_route_metars(?array $bounds, array $exclude, ?array $route,
                            int $limit = 12, float $corridorNm = 50): array {
    if (!$bounds) {
        return ['available' => false, 'reason' => 'no route corridor', 'stations' => [], 'total' => 0];
    }

    $bbox = implode(',', [
        number_format($bounds['minLat'], 3, '.', ''), number_format($bounds['minLon'], 3, '.', ''),
        number_format($bounds['maxLat'], 3, '.', ''), number_format($bounds['maxLon'], 3, '.', ''),
    ]);

    $res = fetch_all(['m' => NOAA_API . '/metar?bbox=' . urlencode($bbox) . '&format=json']);
    if ($res['m'] === null) {
        // Must not read as "no stations out there".
        return ['available' => false, 'reason' => 'route weather lookup failed',
                'stations' => [], 'total' => 0];
    }

    $rows = json_decode($res['m'], true);
    if (!is_array($rows)) {
        return ['available' => false, 'reason' => 'route weather lookup failed',
                'stations' => [], 'total' => 0];
    }

    $skip = array_flip(array_map('strtoupper', $exclude));
    $rank = ['LIFR' => 0, 'IFR' => 1, 'MVFR' => 2, 'VFR' => 3];

    $stations = [];
    foreach ($rows as $r) {
        if (empty($r['rawOb'])) continue;
        if (isset($skip[strtoupper((string)($r['icaoId'] ?? ''))])) continue;

        $off = $route
            ? cross_track_nm($route['from'], $route['to'],
                             ['lat' => $r['lat'] ?? null, 'lon' => $r['lon'] ?? null])
            : null;
        // Unknown geometry is kept rather than silently dropped.
        if ($off !== null && $off > $corridorNm) continue;

        $stations[] = [
            'icao' => $r['icaoId'] ?? null,
            'fltCat' => $r['fltCat'] ?? null,
            'visib' => $r['visib'] ?? null,
            'wxString' => $r['wxString'] ?? null,
            'offRouteNm' => $off,
            'raw' => $r['rawOb'],
        ];
    }

    usort($stations, function ($a, $b) use ($rank) {
        $d = ($rank[$a['fltCat']] ?? 4) <=> ($rank[$b['fltCat']] ?? 4);
        if ($d !== 0) return $d;
        return ($a['offRouteNm'] ?? 1e9) <=> ($b['offRouteNm'] ?? 1e9);
    });

    $belowVfr = 0;
    foreach ($stations as $s) {
        if ($s['fltCat'] && $s['fltCat'] !== 'VFR') $belowVfr++;
    }

    return [
        'available' => true,
        'corridorNm' => $corridorNm,
        'total' => count($stations),
        'belowVfr' => $belowVfr,
        'stations' => array_slice($stations, 0, $limit),
    ];
}

function describe_route_weather(?array $rw): string {
    if (!$rw || empty($rw['available'])) {
        return 'Enroute stations not checked (' . ($rw['reason'] ?? 'no data') . ')';
    }
    if (!$rw['stations']) return 'No reporting stations found inside the route corridor.';

    $within = ' within ' . (int)$rw['corridorNm'] . 'nm of track';
    $head = $rw['belowVfr']
        ? "{$rw['belowVfr']} of {$rw['total']} stations$within reporting below VFR:"
        : "All {$rw['total']} stations$within reporting VFR:";

    $rows = [];
    foreach ($rw['stations'] as $s) {
        $bits = [$s['fltCat'] ?: '—'];
        if ($s['visib'] !== null) $bits[] = $s['visib'] . 'SM';
        if ($s['wxString']) $bits[] = $s['wxString'];
        if ($s['offRouteNm'] !== null) $bits[] = round($s['offRouteNm']) . 'nm off track';
        $rows[] = '  ' . str_pad((string)$s['icao'], 5) . ' ' . implode(' · ', $bits);
    }
    if ($rw['total'] > count($rw['stations'])) {
        $rows[] = '  …' . ($rw['total'] - count($rw['stations'])) . ' further stations in corridor.';
    }

    return implode("\n", array_merge([$head], $rows));
}

function metar_from(?string $json, string $icao): ?array {
    if (!$json) return null;
    $d = json_decode($json, true);
    $ob = $d[0] ?? null;
    if (!isset($ob['rawOb'])) return null;

    $alt = compute_altitudes(
        $ob['elev'] ?? null, $ob['temp'] ?? null,
        $ob['dewp'] ?? null, $ob['altim'] ?? null
    );

    // Pass through only what NOAA decoded — no local METAR parsing.
    return [
        'raw'      => $ob['rawOb'],
        'station'  => $ob['name'] ?? $icao,
        'lat'      => $ob['lat'] ?? null,
        'lon'      => $ob['lon'] ?? null,
        'elev'     => $ob['elev'] ?? null,
        'pressureAltitude' => $alt['pressureAltitude'],
        'densityAltitude'  => $alt['densityAltitude'],
        'fltCat'   => $ob['fltCat'] ?? null,
        'wdir'     => $ob['wdir'] ?? null,
        'wspd'     => $ob['wspd'] ?? null,
        'wgst'     => $ob['wgst'] ?? null,
        'visib'    => $ob['visib'] ?? null,
        'wxString' => $ob['wxString'] ?? null,
        'temp'     => $ob['temp'] ?? null,
        'dewp'     => $ob['dewp'] ?? null,
        'altim'    => $ob['altim'] ?? null,
        'clouds'   => is_array($ob['clouds'] ?? null) ? $ob['clouds'] : [],
    ];
}

function describe_station(string $label, string $icao, ?array $m, $taf = null): string {
    if (!$m) return "$label ($icao): weather unavailable";

    $bits = [];
    if ($m['fltCat']) $bits[] = $m['fltCat'];

    if ($m['wdir'] === 0 && $m['wspd'] === 0) {
        $bits[] = 'Wind calm';
    } elseif ($m['wspd'] !== null) {
        $dir = ($m['wdir'] === 'VRB') ? 'variable' : $m['wdir'] . '°';
        $bits[] = "Wind $dir at {$m['wspd']}kt" . ($m['wgst'] ? " gusting {$m['wgst']}kt" : '');
    }

    if ($m['visib'] !== null) $bits[] = "Vis {$m['visib']}SM";
    if ($m['wxString']) $bits[] = "Wx {$m['wxString']}";

    $ceil = null;
    foreach ($m['clouds'] as $c) {
        if (in_array($c['cover'] ?? '', ['BKN', 'OVC'], true)) { $ceil = $c; break; }
    }
    $bits[] = $ceil
        ? "Ceiling {$ceil['cover']} " . number_format($ceil['base']) . 'ft'
        : 'No ceiling reported';

    if ($m['temp'] !== null) {
        $bits[] = round($m['temp']) . '°C/' . round($m['dewp']) . '°C';
    }
    if ($m['altim'] !== null) {
        $bits[] = 'Altimeter ' . number_format($m['altim'] / 33.8639, 2) . 'inHg';
    }

    // Mike's first briefing item: temperature + pressure altitude drive aircraft
    // performance. Density altitude is the number that actually matters.
    if (($m['densityAltitude'] ?? null) !== null) {
        $bits[] = 'Density alt ' . number_format($m['densityAltitude']) . 'ft';
    }

    $lines = ["$label ($icao): " . implode(' · ', $bits), '  ' . $m['raw']];
    if (is_array($taf) ? !empty($taf['raw']) : $taf) $lines[] = '  ' . (is_array($taf) ? $taf['raw'] : $taf);
    return implode("\n", $lines);
}

function describe_winds(string $label, array $w): string {
    if (empty($w['available'])) {
        return "$label: winds aloft unavailable (" . ($w['reason'] ?? 'no data') . ')';
    }
    $wind = $w['lightVariable'] ? 'light and variable' : "{$w['dir']}° at {$w['speed']}kt";
    $station = $w['substituted'] ? "{$w['station']} (nearest FB station)" : $w['station'];
    $temp = $w['temp'] !== null ? ", {$w['temp']}°C" : '';
    $level = ($w['requestedAltitude'] && $w['requestedAltitude'] !== $w['level'])
        ? number_format($w['level']) . 'ft (nearest to filed ' . number_format($w['requestedAltitude']) . 'ft)'
        : number_format($w['level']) . 'ft';
    return "$label: $level — $wind$temp\n  station $station, raw {$w['raw']}";
}

// ----------------------------------------------------- spoken briefing -----
// Mirror of src/voice-briefing.js. A voice briefing is NOT the written one read
// aloud: raw METAR strings are unlistenable, and a synthesiser reads "210" as
// "two hundred ten" — wrong for a heading, which is spoken digit by digit.

const V_DIGITS = ['zero','one','two','three','four','five','six','seven','eight','nine'];

function v_digits($n): string {
    if ($n === null) return '';
    $s = (string)abs((int)round((float)$n));
    $out = [];
    foreach (str_split($s) as $d) $out[] = V_DIGITS[(int)$d] ?? $d;
    return implode(' ', $out);
}

function v_heading($deg): string {
    if ($deg === null) return '';
    $s = str_pad((string)(int)round((float)$deg), 3, '0', STR_PAD_LEFT);
    $out = [];
    foreach (str_split($s) as $d) $out[] = V_DIGITS[(int)$d] ?? $d;
    return implode(' ', $out);
}

function v_altitude($ft): string {
    if ($ft === null) return '';
    $n = (int)round((float)$ft);
    if ($n >= 18000) return 'flight level ' . v_digits((int)round($n / 100));
    if ($n >= 1000 && $n % 1000 === 0) return v_digits($n / 1000) . ' thousand feet';
    return number_format($n) . ' feet';
}

function v_place(?string $name, ?string $icao): string {
    if (!$name) return v_icao($icao);
    $s = explode(',', $name)[0];
    $s = preg_replace('/\bIntl\b/i', 'International', $s);
    $s = preg_replace('/\bRgnl\b/i', 'Regional', $s);
    $s = preg_replace('/\bMuni\b/i', 'Municipal', $s);
    $s = preg_replace('/\bArpt\b/i', 'Airport', $s);
    $s = preg_replace('/\bFt\b/i', 'Fort', $s);
    $s = preg_replace('/\bSt\b/i', 'Saint', $s);
    return trim(preg_replace('/\s+/', ' ', str_replace(['-', '/'], ' ', $s)));
}

function v_icao(?string $code): string {
    $nato = ['A'=>'Alpha','B'=>'Bravo','C'=>'Charlie','D'=>'Delta','E'=>'Echo','F'=>'Foxtrot',
             'G'=>'Golf','H'=>'Hotel','I'=>'India','J'=>'Juliet','K'=>'Kilo','L'=>'Lima',
             'M'=>'Mike','N'=>'November','O'=>'Oscar','P'=>'Papa','Q'=>'Quebec','R'=>'Romeo',
             'S'=>'Sierra','T'=>'Tango','U'=>'Uniform','V'=>'Victor','W'=>'Whiskey',
             'X'=>'X-ray','Y'=>'Yankee','Z'=>'Zulu'];
    $out = [];
    foreach (str_split(strtoupper((string)$code)) as $c) {
        $out[] = $nato[$c] ?? (ctype_digit($c) ? V_DIGITS[(int)$c] : $c);
    }
    return implode(' ', $out);
}

/**
 * Aviation contractions expanded for speech. "LLWS +10 KT DURD RWY 22" spoken
 * verbatim is noise — and it is the most actionable line in the briefing.
 * Longest keys first so DURD is not partially matched.
 */
function v_expand(?string $text): string {
    if (!$text) return '';
    $s = strtoupper($text);
    $map = [
        '/\bLLWS\b/' => 'low level wind shear', '/\bDURGD\b/' => 'during descent',
        '/\bDURD\b/' => 'during descent', '/\bDURC\b/' => 'during climb',
        '/\bINTMT\b/' => 'intermittent', '/\bOCNL\b/' => 'occasional',
        '/\bCONS\b/' => 'continuous', '/\bMOD\b/' => 'moderate', '/\bSEV\b/' => 'severe',
        '/\bLGT\b/' => 'light', '/\bNEG\b/' => 'negative', '/\bMX\b/' => 'mixed',
        '/\bCHOP\b/' => 'chop', '/\bTURB\b/' => 'turbulence', '/\bSKC\b/' => 'sky clear',
        '/\bOVC\b/' => 'overcast', '/\bBKN\b/' => 'broken', '/\bSCT\b/' => 'scattered',
        '/\bFEW\b/' => 'few', '/\bTOPS?\b/' => 'tops', '/\bBLO\b/' => 'below',
        '/\bABV\b/' => 'above', '/\bRWY\b/' => 'runway', '/\bKTS?\b/' => 'knots',
        '/\bVIS\b/' => 'visibility', '/\bWX\b/' => 'weather',
        '/\bTSTMS?\b/' => 'thunderstorms', '/\bCB\b/' => 'cumulonimbus',
    ];
    $s = preg_replace(array_keys($map), array_values($map), $s);
    $s = preg_replace_callback('/\bFL(\d{3})\b/', fn($m) => 'flight level ' . v_digits($m[1]), $s);
    $s = preg_replace('/\+\s*(\d+)/', 'plus $1', $s);
    $s = preg_replace('/-\s*(\d+)/', 'minus $1', $s);
    return strtolower(trim(preg_replace('/\s+/', ' ', $s)));
}

function v_category(?string $c): string {
    return ['VFR'=>'V F R','MVFR'=>'marginal V F R','IFR'=>'I F R','LIFR'=>'low I F R'][$c]
        ?? ($c ?: 'category unavailable');
}

function v_station(string $role, ?string $icao, ?array $m): string {
    if (!$m) return "$role, " . v_icao($icao) . ', no observation available.';

    $parts = ["$role, " . v_place($m['station'] ?? null, $icao) . ', is ' . v_category($m['fltCat'] ?? null)];

    if (($m['wdir'] ?? null) === 0 && ($m['wspd'] ?? null) === 0) {
        $parts[] = 'wind calm';
    } elseif (($m['wspd'] ?? null) !== null) {
        $dir = ($m['wdir'] === 'VRB') ? 'wind variable' : 'wind ' . v_heading($m['wdir']);
        $gust = !empty($m['wgst']) ? ' gusting ' . v_digits($m['wgst']) : '';
        $parts[] = "$dir at " . v_digits($m['wspd']) . $gust;
    }

    if (($m['visib'] ?? null) !== null) {
        $parts[] = 'visibility ' . str_replace('+', ' or more', (string)$m['visib']) . ' miles';
    }

    foreach ($m['clouds'] ?? [] as $c) {
        if (in_array($c['cover'] ?? '', ['BKN', 'OVC'], true)) {
            $parts[] = 'ceiling ' . ($c['cover'] === 'OVC' ? 'overcast' : 'broken') . ' ' . v_altitude($c['base']);
            break;
        }
    }

    if (($m['temp'] ?? null) !== null) $parts[] = 'temperature ' . round($m['temp']) . ' Celsius';

    // Density altitude only earns airtime when materially above the field.
    if (($m['densityAltitude'] ?? null) !== null && ($m['elev'] ?? null) !== null) {
        $fieldFt = $m['elev'] * 3.280839895;
        $excess = $m['densityAltitude'] - $fieldFt;
        if ($excess >= 1000) {
            $parts[] = 'density altitude ' . number_format($m['densityAltitude']) . ' feet, about '
                     . (round($excess / 100) * 100) . ' feet above field elevation';
        }
    }

    return implode(', ', $parts) . '.';
}

function build_voice_briefing(array $d): string {
    $w = $d['weather'] ?? [];
    $dep = $w['departure'] ?? []; $arr = $w['arrival'] ?? [];
    $lines = [];

    $from = v_place($dep['metar']['station'] ?? null, $dep['airport'] ?? null);
    $to   = v_place($arr['metar']['station'] ?? null, $arr['airport'] ?? null);
    $lvl  = !empty($d['altitude']) ? ', ' . v_altitude($d['altitude']) : '';
    $lines[] = "Flight Service briefing. $from to $to$lvl.";

    // Hazards lead — this is the part that changes a decision.
    $lines[] = 'Adverse conditions first.';
    $h = $d['hazards'] ?? null;
    if (!$h || empty($h['available'])) {
        $lines[] = 'Adverse conditions were not checked.';
    } else {
        $conv = $h['convectiveSigmets'] ?? [];
        if ($conv) {
            $tops = array_filter(array_column($conv, 'altitudeHigh'), fn($v) => $v !== null);
            $top = $tops ? ', tops to ' . v_altitude(max($tops)) : '';
            $n = count($conv);
            $lines[] = ($n === 1 ? 'One convective SIGMET' : "$n convective SIGMETs") . " on route$top.";
        }
        foreach (array_slice($h['sigmets'] ?? [], 0, 2) as $s) {
            $lines[] = 'SIGMET for ' . strtolower($s['hazard'] ?? 'hazardous weather') . ' on route.';
        }
        $byHaz = [];
        foreach ($h['gairmets'] ?? [] as $g) $byHaz[$g['hazard']] = $g;
        foreach (['ICE' => 'icing', 'TURB-HI' => 'turbulence', 'TURB-LO' => 'turbulence'] as $k => $label) {
            if (!isset($byHaz[$k])) continue;
            $t = $byHaz[$k]['top']['ft'] ?? null;
            $lines[] = "Airmet for $label" . ($t !== null ? ' up to ' . v_altitude($t) : '') . '.';
        }
        $urgent = array_values(array_filter($h['pireps'] ?? [], fn($p) => !empty($p['urgent'])));
        foreach (array_slice($urgent, 0, 2) as $p) {
            $at = ($p['flightLevel'] ?? null) !== null ? ' at ' . v_altitude($p['flightLevel']) : '';
            $what = preg_match('#/RM\s+(.+?)(?:/[A-Z]{2}\s|$)#', (string)$p['raw'], $mm)
                ? v_expand($mm[1]) : 'see the full report';
            $lines[] = "Urgent pilot report$at: $what.";
        }
        if (count($lines) === 2) $lines[] = 'No SIGMETs or airmets on route.';
    }

    $lines[] = v_station('Departure', $dep['airport'] ?? null, $dep['metar'] ?? null);
    $lines[] = v_station('Arrival', $arr['airport'] ?? null, $arr['metar'] ?? null);

    $useW = !empty($d['winds']['arrival']['available']) ? $d['winds']['arrival']
          : ($d['winds']['departure'] ?? null);
    if (!empty($useW['available'])) {
        $wind = !empty($useW['lightVariable'])
            ? 'light and variable'
            : v_heading($useW['dir']) . ' at ' . v_digits($useW['speed']);
        // Winds-aloft temps are negative at cruise but POSITIVE at low level in
        // summer. Hardcoding "minus" told a GA pilot at 6,000 ft it was minus 26
        // when the report said plus 26 — that inverts an icing assessment.
        $t = ($useW['temp'] ?? null) !== null
            ? ', temperature ' . ($useW['temp'] < 0 ? 'minus' : 'plus') . ' ' . v_digits(abs($useW['temp']))
            : '';
        $lines[] = 'Winds aloft at ' . v_altitude($useW['level']) . ", $wind$t.";
    }

    // Counts and distances are ordinary numbers, NOT digit strings — a briefer
    // says "thirteen stations within fifty miles", never "one three stations".
    $rw = $d['routeWeather'] ?? null;
    if (!empty($rw['available']) && !empty($rw['total'])) {
        $within = 'within ' . round($rw['corridorNm']) . ' miles of track';
        $lines[] = $rw['belowVfr']
            ? "Enroute, {$rw['belowVfr']} of {$rw['total']} stations $within are below V F R."
            : "Enroute, all {$rw['total']} stations $within are reporting V F R.";
    }

    // Scaffolding must be stated aloud — a listener cannot see a badge.
    $mock = false;
    foreach ($d['notams'] ?? [] as $n) if (($n['source'] ?? '') === 'placeholder') $mock = true;
    if ($mock || (($d['sua']['source'] ?? '') === 'placeholder')) {
        $lines[] = 'NOTAMs and special use airspace are not connected in this demo, and were not checked.';
    }

    $lines[] = 'This is advisory only and is not an official F A A briefing. '
             . 'The pilot in command remains responsible for the go, no go decision.';

    return implode(' ', $lines);
}

// ---------------------------------------------------------------- TFRs ----
// Mirror of src/tfr-fetcher.js. The TFR list needs NO authentication (unlike
// the FAA NOTAM API, which is regulation-gated and 401s). Two stages: the list
// carries no geometry, so detail XML is fetched only for state-matched
// candidates. Pre-filter is by state, so a TFR just across a state line can be
// missed — the UI says so.

const TFR_LIST = 'https://tfr.faa.gov/tfrapi/exportTfrList';
const TFR_MAX_DETAIL = 12;

/** "46.9N" -> 46.9 ; "115.20833333W" -> -115.208 */
function tfr_coord(?string $t): ?float {
    if (!$t) return null;
    if (!preg_match('/^([\d.]+)([NSEW])$/i', trim($t), $m)) return null;
    $n = (float)$m[1];
    if ($n > 180) return null; // guard a DMS value read as decimal
    return (strtoupper($m[2]) === 'S' || strtoupper($m[2]) === 'W') ? -$n : $n;
}

/** "Dallas-Ft Worth Intl, TX, US" -> "TX" */
function tfr_state_from_name(?string $name): ?string {
    if (!$name) return null;
    $p = array_map('trim', explode(',', $name));
    $st = count($p) >= 2 ? $p[count($p) - 2] : null;
    return ($st && preg_match('/^[A-Z]{2}$/', $st)) ? $st : null;
}

function tfr_tag(string $xml, string $name): ?string {
    return preg_match("#<$name>([^<]*)</$name>#", $xml, $m) ? trim($m[1]) : null;
}

function tfr_parse_detail(string $xml): array {
    $points = [];
    if (preg_match_all('#<Avx>(.*?)</Avx>#s', $xml, $ms)) {
        foreach ($ms[1] as $blk) {
            $la = tfr_coord(tfr_tag($blk, 'geoLat'));
            $lo = tfr_coord(tfr_tag($blk, 'geoLong'));
            if ($la !== null && $lo !== null) $points[] = ['lat' => $la, 'lon' => $lo];
        }
    }
    $up = tfr_tag($xml, 'valDistVerUpper');
    $lw = tfr_tag($xml, 'valDistVerLower');
    return [
        'points' => $points,
        'city' => tfr_tag($xml, 'txtNameCity'),
        'effective' => tfr_tag($xml, 'dateEffective'),
        'expires' => tfr_tag($xml, 'dateExpire'),
        'lowerFt' => $lw === null ? null : (float)$lw,
        'upperFt' => $up === null ? null : (float)$up,
    ];
}

/** Nearest vertex-to-route distance. Under-measures a large polygon the route
 *  crosses, so it is paired with a generous threshold — bias toward showing. */
function tfr_nearest_nm(array $points, array $route): ?float {
    $best = null;
    foreach ($points as $p) {
        foreach ($route as $r) {
            $d = distance_nm($p, $r);
            if ($d !== null && ($best === null || $d < $best)) $best = $d;
        }
    }
    return $best;
}

function fetch_tfrs(array $routePoints, array $states, float $corridorNm = 100): array {
    $usable = [];
    foreach ($routePoints as $p) {
        if (is_numeric($p['lat'] ?? null) && is_numeric($p['lon'] ?? null)) $usable[] = $p;
    }
    if (!$usable) return ['available' => false, 'reason' => 'no route geometry', 'tfrs' => [], 'checked' => 0];

    $res = fetch_all(['l' => TFR_LIST]);
    if ($res['l'] === null) {
        // Must not read as "no TFRs out there".
        return ['available' => false, 'reason' => 'TFR source unavailable', 'tfrs' => [], 'checked' => 0];
    }
    $list = json_decode($res['l'], true);
    if (!is_array($list)) {
        return ['available' => false, 'reason' => 'TFR source unavailable', 'tfrs' => [], 'checked' => 0];
    }

    $wanted = array_flip(array_map('strtoupper', array_filter($states)));
    $cands = [];
    foreach ($list as $t) {
        if (isset($wanted[strtoupper((string)($t['state'] ?? ''))])) $cands[] = $t;
    }

    $truncated = max(0, count($cands) - TFR_MAX_DETAIL);
    $cands = array_slice($cands, 0, TFR_MAX_DETAIL);

    $urls = [];
    foreach ($cands as $i => $t) {
        $urls[$i] = 'https://tfr.faa.gov/download/detail_'
                  . str_replace('/', '_', (string)$t['notam_id']) . '.xml';
    }
    $bodies = $urls ? fetch_all($urls) : [];

    $out = [];
    foreach ($cands as $i => $t) {
        $body = $bodies[$i] ?? null;
        $d = $body ? tfr_parse_detail($body) : ['points' => [], 'city' => null,
             'effective' => null, 'expires' => null, 'lowerFt' => null, 'upperFt' => null];
        $near = $d['points'] ? tfr_nearest_nm($d['points'], $usable) : null;
        // Unknown geometry is kept rather than dropped silently.
        if ($near !== null && $near > $corridorNm) continue;

        $out[] = [
            'id' => $t['notam_id'] ?? null,
            'type' => $t['type'] ?? null,
            'facility' => $t['facility'] ?? null,
            'state' => $t['state'] ?? null,
            'city' => $d['city'],
            'description' => $t['description'] ?? null,
            'lowerFt' => $d['lowerFt'], 'upperFt' => $d['upperFt'],
            'effective' => $d['effective'], 'expires' => $d['expires'],
            'nearestNm' => $near === null ? null : (int)round($near),
            'geometryUnknown' => !$d['points'],
        ];
    }

    usort($out, fn($a, $b) => ($a['nearestNm'] ?? 1e9) <=> ($b['nearestNm'] ?? 1e9));

    return [
        'available' => true, 'corridorNm' => $corridorNm,
        'states' => array_keys($wanted), 'totalActive' => count($list),
        'checked' => count($cands), 'truncated' => $truncated, 'tfrs' => $out,
    ];
}

function describe_tfrs(?array $t): string {
    if (!$t || empty($t['available'])) {
        return 'Temporary flight restrictions not checked (' . ($t['reason'] ?? 'no data') . ')';
    }
    $lines = [];
    foreach ($t['tfrs'] as $r) {
        $band = $r['upperFt'] !== null ? ' — surface to ' . number_format($r['upperFt']) . 'ft' : '';
        $near = $r['nearestNm'] !== null ? ' · ' . $r['nearestNm'] . 'nm from route' : '';
        $geo = $r['geometryUnknown'] ? ' · extent unknown, shown to be safe' : '';
        $lines[] = '• ' . ($r['type'] ?: 'TFR') . ' ' . $r['id'] . ' — '
                 . ($r['city'] ?: $r['state'] ?: '') . $band . $near . $geo;
        if ($r['description']) $lines[] = '    ' . $r['description'];
    }
    if (!$lines) {
        $lines[] = 'No TFRs within ' . (int)$t['corridorNm'] . 'nm of the route ('
                 . $t['totalActive'] . ' active nationally, ' . $t['checked']
                 . ' checked in ' . implode('/', $t['states']) . ').';
    }
    if (!empty($t['truncated'])) {
        $lines[] = '⚠ ' . $t['truncated'] . ' further TFR' . ($t['truncated'] > 1 ? 's' : '')
                 . ' in these states were not checked for extent. Confirm against tfr.faa.gov.';
    }
    return implode("\n", $lines);
}

// --------------------------------------------------------- flight time ----
// Mirror of src/flight-time.js. TAF semantics that must not be flattened:
//   FM lines REPLACE the prevailing forecast.
//   TEMPO/PROB are conditional OVERLAYS and do NOT replace the base.
// Reporting a PROB30 thunderstorm as expected weather overstates it; dropping
// it hides the thing the pilot most needs.

function ft_resolve_times(?string $depHHMM, ?string $eetHHMM, ?int $nowSec = null): ?array {
    if (!$depHHMM || !preg_match('/^([01]\d|2[0-3])[0-5]\d$/', $depHHMM)) return null;
    $now = $nowSec ?? time();

    $hh = (int)substr($depHHMM, 0, 2);
    $mm = (int)substr($depHHMM, 2);
    $etd = gmmktime($hh, $mm, 0, (int)gmdate('n', $now), (int)gmdate('j', $now), (int)gmdate('Y', $now));

    // Within the last hour still counts as today; otherwise roll to tomorrow so
    // a plan filed at 2350Z for 0010Z briefs the right day.
    if ($etd < $now - 3600) $etd += 86400;

    $eta = null;
    if ($eetHHMM && preg_match('/^\d{2}[0-5]\d$/', $eetHHMM)) {
        $eta = $etd + ((int)substr($eetHHMM, 0, 2) * 3600) + ((int)substr($eetHHMM, 2) * 60);
    }

    return ['etd' => $etd, 'eta' => $eta,
            'hoursToDeparture' => round(($etd - $now) / 3600, 1)];
}

function ft_is_overlay(array $p): bool {
    $c = strtoupper((string)($p['fcstChange'] ?? ''));
    return in_array($c, ['TEMPO', 'PROB'], true) || ($p['probability'] ?? null) !== null;
}

function ft_ceiling($clouds): ?array {
    foreach ($clouds ?? [] as $c) {
        if (in_array($c['cover'] ?? '', ['BKN', 'OVC'], true)) {
            return ['cover' => $c['cover'], 'base' => $c['base'] ?? null];
        }
    }
    return null;
}

/** VFR/MVFR/IFR/LIFR from forecast visibility and ceiling. NOAA does not
 *  publish fltCat on TAF periods, so it is derived — and only with visibility,
 *  since a category from half the inputs is worse than none. */
function ft_categorise($visib, $ceilingFt): ?string {
    if ($visib === null || $visib === '') return null;
    $v = (float)str_replace('+', '', (string)$visib);
    if (!is_finite($v)) return null;
    $c = $ceilingFt === null ? INF : (float)$ceilingFt;

    if ($v < 1 || $c < 500) return 'LIFR';
    if ($v < 3 || $c < 1000) return 'IFR';
    if ($v <= 5 || $c <= 3000) return 'MVFR';
    return 'VFR';
}

function ft_summarise(?array $p): ?array {
    if (!$p) return null;
    $ceil = ft_ceiling($p['clouds'] ?? null);
    return [
        'from' => $p['timeFrom'] ?? null, 'to' => $p['timeTo'] ?? null,
        'change' => $p['fcstChange'] ?? null, 'probability' => $p['probability'] ?? null,
        'wdir' => $p['wdir'] ?? null, 'wspd' => $p['wspd'] ?? null, 'wgst' => $p['wgst'] ?? null,
        'visib' => $p['visib'] ?? null, 'wxString' => $p['wxString'] ?? null,
        'ceiling' => $ceil,
        'category' => ft_categorise($p['visib'] ?? null, $ceil['base'] ?? null),
    ];
}

/** Governing base period plus conditional overlays covering a moment. */
function ft_forecast_at(?array $periods, ?int $epoch): ?array {
    if (!$periods || $epoch === null) return null;

    $base = null; $overlays = [];
    foreach ($periods as $p) {
        $from = (int)($p['timeFrom'] ?? 0); $to = (int)($p['timeTo'] ?? 0);
        if (!($from <= $epoch && $epoch < $to)) continue;
        if (ft_is_overlay($p)) $overlays[] = ft_summarise($p);
        else $base = ft_summarise($p);   // later FM wins
    }
    if (!$base && !$overlays) return null;
    return ['base' => $base, 'overlays' => array_values(array_filter($overlays))];
}

/** Mike's "weather +/- 1 hour of departure and arrival" rule. */
function ft_scan_window(?array $periods, ?int $centre, float $halfHours = 1): ?array {
    if (!$periods || $centre === null) return null;
    $from = $centre - (int)($halfHours * 3600);
    $to   = $centre + (int)($halfHours * 3600);
    $rank = ['VFR' => 3, 'MVFR' => 2, 'IFR' => 1, 'LIFR' => 0];

    $summaries = [];
    foreach ($periods as $p) {
        if ((int)($p['timeFrom'] ?? 0) < $to && (int)($p['timeTo'] ?? 0) > $from) {
            $s = ft_summarise($p);
            if ($s && $s['category']) $summaries[] = $s;
        }
    }
    if (!$summaries) return null;

    $worst = $summaries[0];
    foreach ($summaries as $s) {
        if (($rank[$s['category']] ?? 9) < ($rank[$worst['category']] ?? 9)) $worst = $s;
    }
    return [
        'windowHours' => $halfHours,
        'worstCategory' => $worst['category'],
        'conditional' => $worst['probability'] !== null
            || in_array(strtoupper((string)$worst['change']), ['TEMPO', 'PROB'], true),
        'driver' => $worst,
    ];
}

// ------------------------------------------------------- flight plan ------
// FAA Form 7233-4 preparation. Mirror of src/flight-plan.js.
//
// ‼️ NOTHING HERE FILES A FLIGHT PLAN. Filing reaches the FAA only through
// Leidos Flight Service, whose /rest/FP/file endpoint is gated behind Service
// Provider Authorization we do not hold. This produces a complete, validated
// plan for the pilot to review and file themselves.

/** Below FL180 is altitude in HUNDREDS (A040); FL180+ is a flight level (F300). */
function fp_encode_level($ft, string $rules = 'V'): ?string {
    if ($ft === null || !is_numeric($ft) || (float)$ft <= 0) return $rules === 'V' ? 'VFR' : null;
    $n = (float)$ft;
    $h = (int)round($n / 100);
    return ($n >= 18000 ? 'F' : 'A') . str_pad((string)$h, 3, '0', STR_PAD_LEFT);
}

function fp_encode_speed($kt): ?string {
    if ($kt === null || !is_numeric($kt)) return null;
    $n = (int)round((float)$kt);
    if ($n <= 0) return null;
    return 'N' . str_pad((string)$n, 4, '0', STR_PAD_LEFT);
}

function fp_encode_duration($minutes): ?string {
    if ($minutes === null || !is_numeric($minutes)) return null;
    $m = (int)round((float)$minutes);
    if ($m < 0) return null;
    return str_pad((string)intdiv($m, 60), 2, '0', STR_PAD_LEFT)
         . str_pad((string)($m % 60), 2, '0', STR_PAD_LEFT);
}

function fp_great_circle_nm(?array $a, ?array $b): ?float {
    return distance_nm($a, $b);
}

function fp_course_deg(?array $a, ?array $b): ?float {
    foreach ([$a, $b] as $p) {
        if (!$p || !is_numeric($p['lat'] ?? null) || !is_numeric($p['lon'] ?? null)) return null;
    }
    return fmod(rad2deg(bearing_rad($a, $b)) + 360, 360);
}

/**
 * Groundspeed = TAS minus the along-track wind component. The standard planning
 * shortcut; it ignores the small crosswind drift term. An ESTIMATE, labelled.
 */
function fp_estimate_enroute($distanceNm, $tas, $windDir, $windSpeed, $trackDeg): ?array {
    if (!is_numeric($distanceNm) || !is_numeric($tas) || (float)$tas <= 0) return null;

    $gs = (float)$tas;
    $head = null;
    if (is_numeric($windDir) && is_numeric($windSpeed) && is_numeric($trackDeg)) {
        $head = (float)$windSpeed * cos(deg2rad((float)$windDir - (float)$trackDeg));
        $gs = (float)$tas - $head;
    }
    // A forecast headwind at or above TAS means it is not flyable as filed.
    if ($gs <= 5) return null;

    return [
        'minutes' => (int)round(((float)$distanceNm / $gs) * 60),
        'groundSpeed' => (int)round($gs),
        'headwindComponent' => $head === null ? null : (int)round($head),
    ];
}

// Wake category is set by max certificated take-off mass (FAA Order 7360.1):
// L <= 15,500 lb, M < 300,000 lb, H >= 300,000 lb. Only unambiguous common
// types are pre-filled; anything else is left to the pilot rather than guessed.
const FP_WAKE = [
    'C172'=>'L','C152'=>'L','C182'=>'L','C206'=>'L','C210'=>'L','PA28'=>'L','PA32'=>'L',
    'PA44'=>'L','BE33'=>'L','BE35'=>'L','BE36'=>'L','SR20'=>'L','SR22'=>'L','DA40'=>'L',
    'DA42'=>'L','M20P'=>'L','C72R'=>'L','PC12'=>'L',
    'BE20'=>'M','C25A'=>'M','C56X'=>'M','E55P'=>'M','B738'=>'M','A320'=>'M','E170'=>'M','CRJ2'=>'M',
    'B744'=>'H','B748'=>'H','B77W'=>'H','A388'=>'H','B763'=>'H','A333'=>'H',
];
const FP_TAS = [
    'C172'=>110,'C152'=>95,'C182'=>140,'C206'=>145,'PA28'=>115,'SR20'=>155,'SR22'=>180,
    'DA40'=>150,'BE36'=>170,'M20P'=>165,'BE20'=>270,'PC12'=>270,'C25A'=>400,
    'B738'=>450,'A320'=>450,'CRJ2'=>420,'B744'=>490,
];

function fp_prefill(array $weather, array $winds, ?string $aircraft, $altitude): array {
    $dep = $weather['departure'] ?? [];
    $arr = $weather['arrival'] ?? [];
    $type = $aircraft ? strtoupper($aircraft) : null;

    $from = ['lat' => $dep['metar']['lat'] ?? null, 'lon' => $dep['metar']['lon'] ?? null];
    $to   = ['lat' => $arr['metar']['lat'] ?? null, 'lon' => $arr['metar']['lon'] ?? null];

    $dist  = fp_great_circle_nm($from, $to);
    $track = fp_course_deg($from, $to);
    $tas   = $type && isset(FP_TAS[$type]) ? FP_TAS[$type] : null;

    $w = !empty($winds['departure']['available']) ? $winds['departure'] : ($winds['arrival'] ?? null);
    $useWind = !empty($w['available']) && empty($w['lightVariable']);

    $est = ($dist !== null && $tas)
        ? fp_estimate_enroute($dist, $tas, $useWind ? $w['dir'] : null,
                              $useWind ? $w['speed'] : null, $track)
        : null;

    return [
        'departure' => $dep['airport'] ?? null,
        'destination' => $arr['airport'] ?? null,
        'aircraftType' => $type,
        'wakeCategory' => $type && isset(FP_WAKE[$type]) ? FP_WAKE[$type] : null,
        'altitude' => $altitude ?: null,
        'cruisingSpeed' => $tas,
        'route' => 'DCT',
        'eet' => $est ? fp_encode_duration($est['minutes']) : null,
        'derived' => [
            'distanceNm' => $dist === null ? null : (int)round($dist),
            'trackDeg' => $track === null ? null : (int)round($track),
            'groundSpeed' => $est['groundSpeed'] ?? null,
            'headwindComponent' => $est['headwindComponent'] ?? null,
            'tasSource' => $tas ? 'typical cruise for type — confirm against your aircraft' : null,
        ],
    ];
}

function fp_build(array $f): array {
    $errors = []; $warnings = [];
    $g = fn($k) => trim((string)($f[$k] ?? ''));

    $rules = strtoupper($g('flightRules') ?: 'V');
    $typeOfFlight = strtoupper($g('typeOfFlight') ?: 'G');

    $required = [
        'aircraftId' => 'Item 7 — aircraft identification',
        'flightRules' => 'Item 8 — flight rules',
        'typeOfFlight' => 'Item 8 — type of flight',
        'aircraftType' => 'Item 9 — type of aircraft',
        'wakeCategory' => 'Item 9 — wake turbulence category',
        'equipment' => 'Item 10 — equipment and capabilities',
        'departure' => 'Item 13 — departure aerodrome',
        'departureTime' => 'Item 13 — proposed departure time (UTC)',
        'cruisingSpeed' => 'Item 15 — cruising speed',
        'destination' => 'Item 16 — destination aerodrome',
        'eet' => 'Item 16 — total estimated elapsed time',
        'endurance' => 'Item 19 — fuel endurance',
        'personsOnBoard' => 'Item 19 — persons on board',
        'aircraftColour' => 'Item 19 — aircraft colour and markings',
        'pilotInCommand' => 'Item 19 — pilot in command and contact',
    ];
    foreach ($required as $k => $label) {
        $v = $f[$k] ?? null;
        if ($v === null || trim((string)$v) === '') $errors[] = "Missing $label.";
    }

    if ($g('aircraftId') && !preg_match('/^[A-Z0-9]{2,7}$/', strtoupper($g('aircraftId')))) {
        $errors[] = 'Item 7 — aircraft identification must be 2–7 letters or digits, no hyphen (N123AB).';
    }
    if ($rules && !in_array($rules, ['I','V','Y','Z'], true)) {
        $errors[] = 'Item 8 — flight rules must be I, V, Y or Z.';
    }
    if ($typeOfFlight && !in_array($typeOfFlight, ['S','N','G','M','X'], true)) {
        $errors[] = 'Item 8 — type of flight must be S, N, G, M or X.';
    }
    if ($g('aircraftType') && !preg_match('/^[A-Z0-9]{2,4}$/', strtoupper($g('aircraftType')))) {
        $errors[] = 'Item 9 — aircraft type must be the 2–4 character ICAO designator (C172).';
    }
    if ($g('wakeCategory') && !in_array(strtoupper($g('wakeCategory')), ['L','M','H','J'], true)) {
        $errors[] = 'Item 9 — wake category must be L, M, H or J.';
    }
    if ($g('departureTime') && !preg_match('/^([01]\d|2[0-3])[0-5]\d$/', $g('departureTime'))) {
        $errors[] = 'Item 13 — departure time must be 4-digit UTC, 0000–2359.';
    }
    if ($g('eet') && !preg_match('/^\d{2}[0-5]\d$/', $g('eet'))) {
        $errors[] = 'Item 16 — estimated elapsed time must be HHMM.';
    }
    if ($g('endurance') && !preg_match('/^\d{2}[0-5]\d$/', $g('endurance'))) {
        $errors[] = 'Item 19 — endurance must be HHMM.';
    }
    if ($g('personsOnBoard') && !preg_match('/^(\d{1,3}|TBN)$/', strtoupper($g('personsOnBoard')))) {
        $errors[] = 'Item 19 — persons on board must be a number, or TBN if not yet known.';
    }

    // Endurance below elapsed time is a fuel-planning problem, not a format one.
    if (preg_match('/^\d{4}$/', $g('eet')) && preg_match('/^\d{4}$/', $g('endurance'))) {
        $mins = fn($s) => (int)substr($s, 0, 2) * 60 + (int)substr($s, 2);
        if ($mins($g('endurance')) <= $mins($g('eet'))) {
            $warnings[] = 'Item 19 — endurance does not exceed estimated elapsed time. Check fuel reserves.';
        }
    }

    $speed = fp_encode_speed($f['cruisingSpeed'] ?? null);
    $level = fp_encode_level($f['altitude'] ?? null, $rules);
    if ($g('cruisingSpeed') && !$speed) $errors[] = 'Item 15 — cruising speed must be knots TAS.';

    $route = strtoupper($g('route')) ?: 'DCT';
    $item18 = $g('otherInformation') ?: '0';
    $item15 = implode(' ', array_filter([$speed, $level, $route]));
    $item19 = 'E/' . $g('endurance')
            . ' P/' . strtoupper($g('personsOnBoard'))
            . ' A/' . strtoupper($g('aircraftColour'))
            . ' C/' . strtoupper($g('pilotInCommand'));

    $icao = '(FPL-' . strtoupper($g('aircraftId')) . '-' . $rules . $typeOfFlight . "\n"
          . '-' . strtoupper($g('aircraftType')) . '/' . strtoupper($g('wakeCategory'))
          . '-' . strtoupper($g('equipment')) . "\n"
          . '-' . strtoupper($g('departure')) . $g('departureTime') . "\n"
          . '-' . $item15 . "\n"
          . '-' . strtoupper($g('destination')) . $g('eet') . "\n"
          . '-' . $item18 . "\n"
          . '-' . $item19 . ')';

    return [
        'ready' => !$errors,
        'errors' => $errors,
        'warnings' => $warnings,
        'encoded' => ['item15' => $item15, 'item18' => $item18, 'item19' => $item19,
                      'speed' => $speed, 'level' => $level],
        'icao' => $icao,
        // Shape matching Leidos /rest/FP/file, for when vendor authorization
        // exists. Not sent anywhere today.
        'leidos' => [
            'type' => 'ICAO',
            'flightRules' => $rules === 'I' ? 'IFR' : 'VFR',
            'aircraftIdentifier' => strtoupper($g('aircraftId')),
            'departure' => strtoupper($g('departure')),
            'destination' => strtoupper($g('destination')),
            'departureInstant' => $g('departureTime') ?: null,
            'flightDuration' => $g('eet') ?: null,
        ],
    ];
}

// ---------------------------------------------------------------- request ---

// Under CLI this file is being included by the conformance tests, which need
// the decode functions above but must not trigger a request.
if (PHP_SAPI === 'cli') return;

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'POST required');
}

$body = json_decode(file_get_contents('php://input') ?: '', true);
if (!is_array($body)) fail(400, 'invalid JSON body');

// Flight plan preparation shares this endpoint (?action=flight-plan) because the
// shared host serves one file. It validates and assembles; it does NOT file.
if (($_GET['action'] ?? '') === 'flight-plan') {
    echo json_encode(array_merge(['status' => 'ok', 'filed' => false], fp_build($body)),
                     JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

$dep = strtoupper(trim((string)($body['departure'] ?? '')));
$arr = strtoupper(trim((string)($body['arrival'] ?? '')));

// Strict validation: these are interpolated into outbound URLs.
foreach ([$dep, $arr] as $code) {
    if (!preg_match('/^[A-Z0-9]{3,4}$/', $code)) {
        fail(400, 'departure and arrival must be 3-4 character ICAO codes');
    }
}

$altitude = (int)($body['altitude'] ?? 0);
$aircraft = preg_replace('/[^A-Z0-9\- ]/', '', strtoupper((string)($body['aircraft'] ?? '')));

$fetched = fetch_all([
    'depMetar' => NOAA_API . '/metar?ids=' . urlencode($dep) . '&format=json',
    'arrMetar' => NOAA_API . '/metar?ids=' . urlencode($arr) . '&format=json',
    'depTaf'   => NOAA_API . '/taf?ids='   . urlencode($dep) . '&format=json',
    'arrTaf'   => NOAA_API . '/taf?ids='   . urlencode($arr) . '&format=json',
]);

// Keep the decoded periods, not just the raw string — they are what lets the
// briefing report conditions at a planned ETD/ETA rather than only now.
$tafRaw = function (?string $json): ?array {
    if (!$json) return null;
    $d = json_decode($json, true);
    $t = $d[0] ?? null;
    if (!isset($t['rawTAF'])) return null;
    return [
        'raw' => $t['rawTAF'],
        'validFrom' => $t['validTimeFrom'] ?? null,
        'validTo' => $t['validTimeTo'] ?? null,
        'periods' => is_array($t['fcsts'] ?? null) ? $t['fcsts'] : [],
    ];
};

$weather = [
    'departure' => ['airport' => $dep, 'metar' => metar_from($fetched['depMetar'], $dep),
                    'taf' => $tafRaw($fetched['depTaf'])],
    'arrival'   => ['airport' => $arr, 'metar' => metar_from($fetched['arrMetar'], $arr),
                    'taf' => $tafRaw($fetched['arrTaf'])],
];

$table = fb_table();
$winds = [
    'departure' => winds_for($dep, $altitude, $table),
    'arrival'   => winds_for($arr, $altitude, $table),
];

// Route geometry: both airports plus the pilot's reported position, so a hazard
// near where the aircraft actually is counts even when it sits off the direct
// line between the airports.
$endpoints = [
    ['lat' => $weather['departure']['metar']['lat'] ?? null,
     'lon' => $weather['departure']['metar']['lon'] ?? null],
    ['lat' => $weather['arrival']['metar']['lat'] ?? null,
     'lon' => $weather['arrival']['metar']['lon'] ?? null],
];

$position = (isset($body['latitude'], $body['longitude'])
             && is_numeric($body['latitude']) && is_numeric($body['longitude']))
    ? ['lat' => (float)$body['latitude'], 'lon' => (float)$body['longitude']]
    : null;

$positionUsed = $position ? position_is_on_route($position, $endpoints) : false;

$dists = [];
foreach ($endpoints as $e) {
    $x = distance_nm($position, $e);
    if ($x !== null) $dists[] = $x;
}
$positionDistanceNm = $dists ? (int)round(min($dists)) : null;

$hazards = fetch_hazards($positionUsed ? array_merge($endpoints, [$position]) : $endpoints);

// Placeholders — flagged so the UI cannot present them as live FAA data.
$notams = [
    ['airport' => $dep, 'text' => 'Check departure airport ATIS for active runways',
     'severity' => 'info', 'source' => 'placeholder'],
    ['airport' => $arr, 'text' => 'Check arrival airport for any temporary closures',
     'severity' => 'info', 'source' => 'placeholder'],
];
$sua = [
    'nearby' => [],
    'message' => 'Special Use Airspace not checked — no SUA data source connected',
    'source' => 'placeholder',
];

$cats = array_values(array_filter([
    $weather['departure']['metar']['fltCat'] ?? null,
    $weather['arrival']['metar']['fltCat'] ?? null,
]));

$head = "BRIEFING: $dep to $arr at " . ($altitude ?: 'VFR') . ($aircraft ? " — $aircraft" : '');

// No go/no-go verdict: this service has no basis to issue one.
// Reuse the hazard corridor so enroute weather and hazards describe the same
// piece of sky.
$routeWeather = fetch_route_metars($hazards['bounds'] ?? null, [$dep, $arr], [
    'from' => ['lat' => $weather['departure']['metar']['lat'] ?? null,
               'lon' => $weather['departure']['metar']['lon'] ?? null],
    'to'   => ['lat' => $weather['arrival']['metar']['lat'] ?? null,
               'lon' => $weather['arrival']['metar']['lon'] ?? null],
]);

// TFRs — states from both endpoints and every corridor station.
$routeStates = array_filter(array_merge(
    [tfr_state_from_name($weather['departure']['metar']['station'] ?? null),
     tfr_state_from_name($weather['arrival']['metar']['station'] ?? null)],
    array_map(fn($s) => tfr_state_from_name($s['name'] ?? null), $routeWeather['stations'] ?? [])
));
$tfrs = fetch_tfrs($endpoints, array_values(array_unique($routeStates)));

$briefing = $head . "\n\nADVERSE CONDITIONS:\n" . describe_hazards($hazards)
    . "\n\nWEATHER:\n"
    . describe_station('Departure', $dep, $weather['departure']['metar'], $weather['departure']['taf']) . "\n\n"
    . describe_station('Arrival', $arr, $weather['arrival']['metar'], $weather['arrival']['taf'])
    . "\n\nENROUTE STATIONS:\n" . describe_route_weather($routeWeather)
    . "\n\nWINDS ALOFT:\n"
    . describe_winds("Departure ($dep)", $winds['departure']) . "\n"
    . describe_winds("Arrival ($arr)", $winds['arrival'])
    . "\n\nTEMPORARY FLIGHT RESTRICTIONS:\n" . describe_tfrs($tfrs)
    . "\n\nNOTAMS:\n"
    . implode("\n", array_map(fn($n) => "• {$n['airport']}: {$n['text']}", $notams))
    . "\n\nAIRSPACE:\n" . $sua['message']
    . "\n\nADVISORY:\n"
    . ($cats ? 'Reported flight category: ' . implode(' / ', $cats) . ".\n" : "Flight category unavailable.\n")
    . "This is not an official FAA weather briefing and does not substitute for one.\n"
    . 'The pilot in command is responsible for the go/no-go decision.';

// Apply the flight plan's times to the briefing. Without a proposed departure
// time this is a report of current conditions; with one, the TAF period
// governing ETD and ETA is what matters.
$times = ft_resolve_times(
    isset($body['departureTime']) ? (string)$body['departureTime'] : null,
    isset($body['eet']) ? (string)$body['eet'] : null
);
$planned = null;
if ($times) {
    $planned = [
        'etd' => $times['etd'],
        'eta' => $times['eta'],
        'hoursToDeparture' => $times['hoursToDeparture'],
        // Current observations stop being representative for a future flight.
        'observationsRepresentative' => $times['hoursToDeparture'] <= 2,
        'departure' => [
            'forecast' => ft_forecast_at($weather['departure']['taf']['periods'] ?? null, $times['etd']),
            'window' => ft_scan_window($weather['departure']['taf']['periods'] ?? null, $times['etd']),
        ],
        'arrival' => [
            'forecast' => ft_forecast_at($weather['arrival']['taf']['periods'] ?? null, $times['eta']),
            'window' => ft_scan_window($weather['arrival']['taf']['periods'] ?? null, $times['eta']),
        ],
    ];
}

// Spoken rendering is built from the same data, not from the text briefing.
$voice = build_voice_briefing([
    'weather' => $weather, 'routeWeather' => $routeWeather, 'winds' => $winds,
    'hazards' => $hazards, 'notams' => $notams, 'sua' => $sua,
    'altitude' => $altitude ?: null,
]);

echo json_encode([
    'status'    => 'ok',
    'briefing'  => $briefing,
    'voice'     => $voice,
    'planned'   => $planned,
    // Everything the briefing already knows, so the pilot types as little as
    // possible on the flight plan. Preparation only — nothing is filed.
    'flightPlanPrefill' => fp_prefill($weather, $winds, $aircraft ?: null, $altitude ?: null),
    'weather'   => $weather,
    'winds'     => $winds,
    'hazards'   => $hazards,
    'tfrs'      => $tfrs,
    'routeWeather' => $routeWeather,
    'notams'    => $notams,
    'sua'       => $sua,
    'aircraft'  => $aircraft ?: null,
    'altitude'  => $altitude ?: null,
    'location'  => [
        'used' => $positionUsed,
        'distanceNm' => $positionDistanceNm,
        'note' => $position
            ? ($positionUsed
                ? "Position is {$positionDistanceNm} nm from the route and was included."
                : "Position is {$positionDistanceNm} nm from the route — too far to be relevant, so it was not used. The briefing covers the filed route only.")
            : 'No position reported; the briefing covers the filed route only.',
    ],
    'timestamp' => gmdate('c'),
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
