<?php
// Text-to-speech proxy — returns audio for the spoken briefing.
//
// WHY THIS EXISTS: the browser's own speech engine (Microsoft Zira and friends)
// is concatenative and sounds robotic. Its only knobs are rate and pitch, and
// slowing the rate is exactly the crude time-stretch that flattened AeroVox.
// A natural cadence has to come from the TTS engine itself.
//
// VOICE SETTINGS are the AeroVox "natural cadence" recipe, arrived at the hard
// way: NEVER post-stretch finished audio — set the engine's NATIVE speed. 0.82
// suits a long read like a briefing; 0.90 is the value for short conversational
// turns and comes out rushed over ~200 words.
//
// ‼️ KEY HANDLING. The key is read from config.local.php, which must be exactly
// `<?php return ['elevenlabs_api_key' => '...'];` — it CANNOT carry the usual
// `<?php exit;` guard, because include() has to reach the return statement.
// That is still safe over HTTP: PHP executes the file and a top-level return
// emits nothing. The protection is that PHP runs at all, so if this host ever
// serves raw .php source again (it has before, via .html twins) the key is
// exposed. Treat it as at-risk: the spend cap below limits damage, and the key
// should be rotated if anything looks wrong.
//
// The key is never echoed in a response or an error, including upstream errors.

declare(strict_types=1);

const MAX_CHARS       = 1600;   // a full briefing is ~1,100
const MAX_PER_IP_HOUR = 40;     // a shared URL must not drain the balance
const VOICE_ID        = 'EXAVITQu4vr4xnSDxMaL'; // Sarah — the KBM female voice
const RATE_FILE       = __DIR__ . '/tts_rate.php';

function fail(int $code, string $msg): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => $msg]);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail(405, 'POST required');

$cfg = __DIR__ . '/config.local.php';
$key = is_readable($cfg) ? (include $cfg)['elevenlabs_api_key'] ?? null : null;

if (!$key) {
    // Explicit, so the page can fall back to browser speech rather than break.
    fail(503, 'voice not configured on this host');
}

$body = json_decode(file_get_contents('php://input') ?: '', true);
$text = trim((string)($body['text'] ?? ''));

if ($text === '') fail(400, 'text required');
if (mb_strlen($text) > MAX_CHARS) {
    fail(413, 'text exceeds ' . MAX_CHARS . ' characters');
}

// --- rate limit -------------------------------------------------------------
// Crude but sufficient: a per-hour counter keyed by hashed IP, behind the same
// .php exit guard as the FB cache so it is never readable over HTTP.
$ip = hash('sha256', ($_SERVER['REMOTE_ADDR'] ?? '?') . '|' . date('YmdH'));
$counts = [];
if (is_readable(RATE_FILE)) {
    $blob = file_get_contents(RATE_FILE);
    $nl = strpos($blob, "\n");
    if ($nl !== false) {
        $d = json_decode(substr($blob, $nl + 1), true);
        if (is_array($d) && ($d['hour'] ?? '') === date('YmdH')) $counts = $d['ips'] ?? [];
    }
}
$counts[$ip] = ($counts[$ip] ?? 0) + 1;
@file_put_contents(RATE_FILE, "<?php exit; ?>\n" .
    json_encode(['hour' => date('YmdH'), 'ips' => $counts]));

if ($counts[$ip] > MAX_PER_IP_HOUR) {
    fail(429, 'too many voice requests from this address this hour');
}

// --- synthesise -------------------------------------------------------------
$payload = json_encode([
    'text' => $text,
    // turbo_v2_5 + native speed is the AeroVox natural-cadence recipe.
    'model_id' => 'eleven_turbo_v2_5',
    'voice_settings' => [
        'stability' => 0.40,
        'similarity_boost' => 0.82,
        'style' => 0.25,
        'use_speaker_boost' => true,
        'speed' => 0.82,
    ],
]);

$ch = curl_init('https://api.elevenlabs.io/v1/text-to-speech/' . VOICE_ID);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_TIMEOUT => 45,
    CURLOPT_HTTPHEADER => [
        'xi-api-key: ' . $key,
        'Content-Type: application/json',
        'Accept: audio/mpeg',
    ],
]);
$audio = curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err = curl_error($ch);
curl_close($ch);

if ($code !== 200 || !$audio) {
    // Never surface the upstream body — it can echo request details.
    error_log("TTS upstream failed: $code $err");
    fail(502, 'voice synthesis unavailable');
}

header('Content-Type: audio/mpeg');
header('Cache-Control: no-store');
header('Content-Length: ' . strlen($audio));
echo $audio;
