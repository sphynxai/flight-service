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
    $temp = null;
    $tp = substr($g, 4);
    if ($tp !== '' && $tp !== false) {
        $n = (int)str_replace('+', '', $tp);
        $temp = (strpos($tp, '+') === 0) ? $n : -abs($n);
    }

    return ['dir' => $dir, 'speed' => $speed, 'temp' => $temp,
            'lightVariable' => $lightVariable, 'raw' => $g];
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
        $lines = explode("\n", $body);
        foreach ($lines as $line) {
            if ($validity === null && strpos($line, 'VALID') === 0) {
                $validity = trim($line);
            }
            $id = trim(substr($line, 0, 3));
            if (!preg_match('/^[A-Z0-9]{3}$/', $id)) continue;

            $levels = [];
            foreach (LEVEL_COLUMNS as $ft => [$start, $len]) {
                $g = fb_parse_group(substr($line, $start, $len));
                if ($g) $levels[$ft] = $g;
            }
            if ($levels) $stations[$id] = $levels;
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

function metar_from(?string $json, string $icao): ?array {
    if (!$json) return null;
    $d = json_decode($json, true);
    $ob = $d[0] ?? null;
    if (!isset($ob['rawOb'])) return null;

    // Pass through only what NOAA decoded — no local METAR parsing.
    return [
        'raw'      => $ob['rawOb'],
        'station'  => $ob['name'] ?? $icao,
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

function describe_station(string $label, string $icao, ?array $m): string {
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

    return "$label ($icao): " . implode(' · ', $bits) . "\n  " . $m['raw'];
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
$briefing = $head . "\n\nWEATHER:\n"
    . describe_station('Departure', $dep, $weather['departure']['metar']) . "\n\n"
    . describe_station('Arrival', $arr, $weather['arrival']['metar'])
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
    'notams'    => $notams,
    'sua'       => $sua,
    'aircraft'  => $aircraft ?: null,
    'altitude'  => $altitude ?: null,
    'timestamp' => gmdate('c'),
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
