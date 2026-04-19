<?php
// Flash Reader — book-added audit log endpoint (PHP).
//
// Called by app.js after a book has been added to IndexedDB. Writes one
// JSONL line per event to books.log in the app root. Matches the format
// produced by book_log.py so either backend can be used interchangeably.

header('Content-Type: application/json; charset=utf-8');

// Keep raw PHP noise out of the response body; we surface errors below as
// JSON so the browser can see what actually broke instead of an empty 500.
ini_set('display_errors', '0');
error_reporting(E_ALL);

// Last-ditch: if a fatal fires before we get to echo, emit a JSON body
// describing it rather than returning 0-byte 500 (which tells the client
// nothing). The browser side treats any error the same way, but we want a
// human reading the response to get a hint.
register_shutdown_function(function () {
    $err = error_get_last();
    $fatal = E_ERROR | E_PARSE | E_CORE_ERROR | E_COMPILE_ERROR | E_USER_ERROR;
    if ($err && ($err['type'] & $fatal)) {
        if (!headers_sent()) {
            http_response_code(500);
            header('Content-Type: application/json; charset=utf-8');
        }
        echo json_encode([
            'ok'    => false,
            'error' => 'fatal: ' . $err['message'],
            'file'  => basename($err['file'] ?? '?'),
            'line'  => $err['line'] ?? 0,
        ]);
    }
});

try {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405);
        echo json_encode(['ok' => false, 'error' => 'method not allowed']);
        exit;
    }

    $raw = file_get_contents('php://input');
    $payload = json_decode($raw, true);
    if (!is_array($payload)) {
        $payload = [];
    }

    // mb_substr preferred for multibyte safety; fall back to substr if
    // mbstring isn't installed. (It usually is on PHP 8.x, but no harm.)
    $truncate = function ($v, $limit = 500) {
        if ($v === null) return '';
        $s = (string) $v;
        return function_exists('mb_substr') ? mb_substr($s, 0, $limit) : substr($s, 0, $limit);
    };

    $title  = $truncate($payload['title']  ?? null);
    $author = $truncate($payload['author'] ?? null);
    $wordCount = null;
    if (isset($payload['wordCount']) && is_numeric($payload['wordCount'])) {
        $wordCount = (int) $payload['wordCount'];
    }

    // Reverse proxies (Cloudflare, nginx, LiteSpeed cache, ...) put the
    // real peer in X-Forwarded-For; REMOTE_ADDR is the proxy's loopback.
    $ip = '-';
    if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        $parts = explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']);
        $ip = trim($parts[0]);
    } elseif (!empty($_SERVER['HTTP_X_REAL_IP'])) {
        $ip = trim($_SERVER['HTTP_X_REAL_IP']);
    } elseif (!empty($_SERVER['REMOTE_ADDR'])) {
        $ip = $_SERVER['REMOTE_ADDR'];
    }

    $user = $_SERVER['PHP_AUTH_USER'] ?? $_SERVER['REMOTE_USER'] ?? '-';
    if ($user === '' || $user === null) $user = '-';

    $entry = [
        'ts'         => gmdate('Y-m-d\TH:i:sP'),
        'event'      => 'book_added',
        'user'       => $user,
        'ip'         => $ip,
        'user_agent' => $_SERVER['HTTP_USER_AGENT'] ?? '-',
        'title'      => $title,
        'author'     => $author,
        'word_count' => $wordCount,
    ];

    $line = json_encode($entry, JSON_UNESCAPED_UNICODE) . "\n";

    // Default: books.log next to index.html (two dirs up from api/log/).
    // Override with READER_LOG_PATH env var to move it elsewhere.
    $logPath = getenv('READER_LOG_PATH');
    if (!$logPath) {
        $logPath = dirname(__DIR__, 2) . DIRECTORY_SEPARATOR . 'books.log';
    }

    $fh = @fopen($logPath, 'a');
    if ($fh === false) {
        $err = error_get_last();
        http_response_code(500);
        echo json_encode([
            'ok'               => false,
            'error'            => 'cannot open log file',
            'log_path'         => $logPath,
            'log_dir_writable' => is_writable(dirname($logPath)),
            'php_error'        => $err['message'] ?? null,
        ]);
        exit;
    }

    // flock() serializes concurrent writes from multiple PHP workers so
    // lines from simultaneous uploads don't interleave in the file.
    if (!flock($fh, LOCK_EX)) {
        fclose($fh);
        http_response_code(500);
        echo json_encode(['ok' => false, 'error' => 'could not lock log']);
        exit;
    }
    fwrite($fh, $line);
    fflush($fh);
    flock($fh, LOCK_UN);
    fclose($fh);

    echo json_encode(['ok' => true]);

} catch (Throwable $e) {
    http_response_code(500);
    error_log('[flash-reader] book-added exception: ' . $e->getMessage());
    echo json_encode([
        'ok'    => false,
        'error' => get_class($e) . ': ' . $e->getMessage(),
        'file'  => basename($e->getFile()),
        'line'  => $e->getLine(),
    ]);
}
