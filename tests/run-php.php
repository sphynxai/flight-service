<?php
// Runs the shared fixtures through the PHP implementation and emits normalized
// results as JSON on stdout. Consumed by conformance.mjs.
// Never prints anything else — stdout must stay parseable.
//
// api.php returns early under CLI, so including it here exposes the decode
// functions without handling a request.

declare(strict_types=1);

require __DIR__ . '/../deploy/kbmsolvedit/api.php';

function fx(string $name): array {
    return json_decode(file_get_contents(__DIR__ . '/fixtures/' . $name), true);
}

function norm(?array $g): ?array {
    if ($g === null) return null;
    return [
        'dir'   => $g['dir'] ?? null,
        'speed' => $g['speed'] ?? null,
        'temp'  => $g['temp'] ?? null,
        'lightVariable' => (bool)($g['lightVariable'] ?? false),
    ];
}

$out = ['groups' => [], 'lines' => [], 'levels' => [], 'stations' => []];

foreach (fx('fb-groups.json')['cases'] as $c) {
    $out['groups'][] = norm(fb_parse_group($c['raw']));
}

foreach (fx('fb-lines.json')['cases'] as $c) {
    $parsed = fb_parse_station_line($c['line']);
    if (!$parsed) { $out['lines'][] = null; continue; }
    // Compare column alignment only: level -> the raw group found there.
    $levels = [];
    foreach ($parsed['levels'] as $ft => $g) $levels[(string)$ft] = $g['raw'];
    $out['lines'][] = ['id' => $parsed['id'], 'levels' => $levels];
}

foreach (fx('levels.json')['cases'] as $c) {
    $out['levels'][] = nearest_level($c['altitude']);
}

foreach (fx('metar-stations.json')['cases'] as $c) {
    $out['stations'][] = describe_station($c['label'], $c['icao'], $c['metar']);
}

// JSON_PRESERVE_ZERO_FRACTION keeps numeric types comparable with the JS side.
echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
