<?php
// Sanity-check endpoint: reports where book-added.php would write the log
// and whether that location is writable from this PHP process. Hit this
// in the browser (while logged in, if auth is on) to diagnose setup.

header('Content-Type: application/json; charset=utf-8');

$logPath = getenv('READER_LOG_PATH');
if (!$logPath) {
    $logPath = dirname(__DIR__, 2) . DIRECTORY_SEPARATOR . 'books.log';
}

$user = $_SERVER['PHP_AUTH_USER'] ?? ($_SERVER['REMOTE_USER'] ?? '-');
if ($user === '') $user = '-';

echo json_encode([
    'ok'                => true,
    'log_path'          => $logPath,
    'log_dir_writable'  => is_writable(dirname($logPath)),
    'log_file_writable' => file_exists($logPath) ? is_writable($logPath) : null,
    'log_file_exists'   => file_exists($logPath),
    'user'              => $user,
    'remote_addr'       => $_SERVER['REMOTE_ADDR'] ?? '-',
    'server'            => $_SERVER['SERVER_SOFTWARE'] ?? '-',
    'php_version'       => PHP_VERSION,
], JSON_PRETTY_PRINT);
