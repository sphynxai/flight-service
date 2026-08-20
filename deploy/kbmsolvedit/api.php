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
const ICAO_TO_FB = ['KDFW' => 'DAL'];

function fail(int $code, string $msg): void {
    http_response_code($code);
    echo json_encode(['error' => $msg]);
    exit;
}

function fetch_all(array $urls): array {
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

function describe_station(string $label, string $icao, ?array $m, ?string $taf = null): string {
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
    if ($taf) $lines[] = '  ' . $taf;
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

// ---------------------------------------------------------------- request ---

// Under CLI this file is being included by the conformance tests, which need
// the decode functions above but must not trigger a request.
if (PHP_SAPI === 'cli') return;

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'POST required');
}

$body = json_decode(file_get_contents('php://input') ?: '', true);
if (!is_array($body)) fail(400, 'invalid JSON body');

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

$tafRaw = function (?string $json): ?string {
    if (!$json) return null;
    $d = json_decode($json, true);
    return $d[0]['rawTAF'] ?? null;
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
$hazards = fetch_hazards([
    ['lat' => $weather['departure']['metar']['lat'] ?? null,
     'lon' => $weather['departure']['metar']['lon'] ?? null],
    ['lat' => $weather['arrival']['metar']['lat'] ?? null,
     'lon' => $weather['arrival']['metar']['lon'] ?? null],
    ['lat' => $body['latitude'] ?? null, 'lon' => $body['longitude'] ?? null],
]);

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

$briefing = $head . "\n\nADVERSE CONDITIONS:\n" . describe_hazards($hazards)
    . "\n\nWEATHER:\n"
    . describe_station('Departure', $dep, $weather['departure']['metar'], $weather['departure']['taf']) . "\n\n"
    . describe_station('Arrival', $arr, $weather['arrival']['metar'], $weather['arrival']['taf'])
    . "\n\nENROUTE STATIONS:\n" . describe_route_weather($routeWeather)
    . "\n\nWINDS ALOFT:\n"
    . describe_winds("Departure ($dep)", $winds['departure']) . "\n"
    . describe_winds("Arrival ($arr)", $winds['arrival'])
    . "\n\nNOTAMS:\n"
    . implode("\n", array_map(fn($n) => "• {$n['airport']}: {$n['text']}", $notams))
    . "\n\nAIRSPACE:\n" . $sua['message']
    . "\n\nADVISORY:\n"
    . ($cats ? 'Reported flight category: ' . implode(' / ', $cats) . ".\n" : "Flight category unavailable.\n")
    . "This is not an official FAA weather briefing and does not substitute for one.\n"
    . 'The pilot in command is responsible for the go/no-go decision.';

echo json_encode([
    'status'    => 'ok',
    'briefing'  => $briefing,
    'weather'   => $weather,
    'winds'     => $winds,
    'hazards'   => $hazards,
    'routeWeather' => $routeWeather,
    'notams'    => $notams,
    'sua'       => $sua,
    'aircraft'  => $aircraft ?: null,
    'altitude'  => $altitude ?: null,
    'timestamp' => gmdate('c'),
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
