<?php
/**
 * Zotero login handler.
 * GET: shows login form
 * POST: verifies password and completes session
 */

// Use Zotero framework for session completion
$host = '127.0.0.1';
$user = getenv('DB_USER') ?: 'zotero';
$pass = getenv('DB_PASS') ?: 'zotropass';

$mysqli = new mysqli($host, $user, $pass, 'zotero', 3306);
if ($mysqli->connect_error) {
    die("DB error: " . $mysqli->connect_error);
}

$sessionToken = $_GET['session'] ?? $_POST['session'] ?? '';
$error = '';

if ($_SERVER['REQUEST_METHOD'] === 'POST' && $sessionToken) {
    $username = trim($_POST['username'] ?? '');
    $password = $_POST['password'] ?? '';

    if (!$username || !$password) {
        $error = "Username and password required";
    } else {
        $stmt = $mysqli->prepare("SELECT userID, password FROM www.users WHERE username = ?");
        $stmt->bind_param('s', $username);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();

        $valid = false;
        if ($row) {
            $valid = password_verify($password, $row['password'])
                  || sha1('dev-salt-change-in-production' . $password) === $row['password']
                  || md5($password) === $row['password'];
        }

        if (!$valid) {
            $error = "Invalid username or password";
        } else {
            $userID = $row['userID'];

            // Get first available API key for this user
            $stmt = $mysqli->prepare("SELECT keyID, `key` FROM `keys` WHERE userID=? LIMIT 1");
            $stmt->bind_param('i', $userID);
            $stmt->execute();
            $keyRow = $stmt->get_result()->fetch_assoc();
            $stmt->close();

            if (!$keyRow) {
                $apiKey = bin2hex(random_bytes(12));
                $stmt = $mysqli->prepare("INSERT INTO `keys` (`key`, userID, name) VALUES (?, ?, 'auto-generated')");
                $stmt->bind_param('si', $apiKey, $userID);
                $stmt->execute();
                $keyID = $stmt->insert_id;
                $stmt->close();
            } else {
                $apiKey = $keyRow['key'];
                $keyID = $keyRow['keyID'];
            }

            // Ensure key has library + write permissions
            $libStmt = $mysqli->prepare("SELECT libraryID FROM users WHERE userID=?");
            $libStmt->bind_param('i', $userID);
            $libStmt->execute();
            $libRow = $libStmt->get_result()->fetch_assoc();
            $libStmt->close();
            $libID = $libRow ? (int)$libRow['libraryID'] : $userID;
            $mysqli->query(
                "INSERT IGNORE INTO keyPermissions (keyID, libraryID, permission, granted) VALUES "
                . "($keyID, $libID, 'library', 1), "
                . "($keyID, $libID, 'write', 1)"
            );

            // Complete session (use UTC timestamps to match PHP timezone)
            $now = gmdate('Y-m-d H:i:s');
            $expires = gmdate('Y-m-d H:i:s', time() + 86400);
            $mysqli->begin_transaction();
            try {
                $stmt = $mysqli->prepare(
                    "UPDATE loginSessions SET userID=?, keyID=?, status='completed', dateCompleted=?, dateExpires=? WHERE sessionToken=?"
                );
                $stmt->bind_param('iisss', $userID, $keyID, $now, $expires, $sessionToken);
                $stmt->execute();
                $stmt->close();

                $mysqli->commit();
            } catch (\Exception $e) {
                $mysqli->rollback();
                $error = "Failed to complete session: " . $e->getMessage();
                ?>
                <!DOCTYPE html>
                <html><head><title>Login Error</title></head>
                <body style="font-family:sans-serif;text-align:center;margin-top:100px">
                <h2 style="color:red">Login Error</h2>
                <p><?= htmlspecialchars($error) ?></p>
                </body></html>
                <?php
                exit;
            }
            $mysqli->close();
            ?>
<!DOCTYPE html>
<html>
<head><title>Login Complete</title></head>
<body style="font-family:sans-serif;text-align:center;margin-top:100px">
<h2 style="color:green">Login successful!</h2>
<p>You can close this window and return to Zotero.</p>
<script>setTimeout(() => window.close(), 2000);</script>
</body>
</html>
            <?php
            exit;
        }
    }
}
$mysqli->close();
?>
<!DOCTYPE html>
<html>
<head>
<title>Zotero Login</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body { font-family: sans-serif; max-width: 400px; margin: 80px auto; padding: 20px; }
h2 { color: #4677b5; }
input { width: 100%; padding: 10px; margin: 8px 0; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px; }
button { width: 100%; padding: 12px; background: #4677b5; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; }
button:hover { background: #3a6599; }
.error { color: #c00; background: #fee; padding: 10px; border-radius: 4px; margin-bottom: 10px; }
.note { color: #888; font-size: small; margin-top: 15px; }
</style>
</head>
<body>
<h2>Zotero Login</h2>
<?php if ($error): ?><div class="error"><?= htmlspecialchars($error) ?></div><?php endif; ?>
<form method="post">
  <input type="hidden" name="session" value="<?= htmlspecialchars($sessionToken) ?>">
  <input name="username" placeholder="Username" autofocus required>
  <input name="password" type="password" placeholder="Password" required>
  <button type="submit">Login</button>
</form>
<p class="note">Don't have an account? <a href="register.php">Register here</a></p>
</body>
</html>
