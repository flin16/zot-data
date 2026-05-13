<?php
/**
 * Minimal user registration for Zotero local dataserver.
 * Self-hosted alternative to ZotPrime admin.
 */

header('Content-Type: text/html; charset=utf-8');

// Connect to MySQL
$host = '127.0.0.1';
$user = getenv('DB_USER') ?: 'zotero';
$pass = getenv('DB_PASS') ?: 'zotropass';

$mysqli = new mysqli($host, $user, $pass, 'zotero', 3306);
if ($mysqli->connect_error) {
    die("DB error: " . $mysqli->connect_error);
}

$error = '';
$success = '';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $username = trim($_POST['username'] ?? '');
    $password = $_POST['password'] ?? '';
    $password2 = $_POST['password2'] ?? '';

    if (strlen($username) < 3) {
        $error = "Username must be at least 3 characters";
    } elseif (strlen($password) < 8) {
        $error = "Password must be at least 8 characters";
    } elseif ($password !== $password2) {
        $error = "Passwords do not match";
    } else {
        // Check if username exists
        $stmt = $mysqli->prepare("SELECT userID FROM www.users WHERE username = ?");
        $stmt->bind_param('s', $username);
        $stmt->execute();
        if ($stmt->get_result()->fetch_assoc()) {
            $error = "Username already exists";
        } else {
            $stmt->close();
            // Hash password (bcrypt)
            $hash = password_hash($password, PASSWORD_DEFAULT);
            // Get next userID
            $res = $mysqli->query("SELECT COALESCE(MAX(userID), 0) + 1 as nextID FROM www.users");
            $nextID = $res->fetch_assoc()['nextID'];
            // Insert into www.users
            $stmt = $mysqli->prepare("INSERT INTO www.users (userID, username, password) VALUES (?, ?, ?)");
            $stmt->bind_param('iss', $nextID, $username, $hash);
            $stmt->execute();
            $stmt->close();
            // Insert into zotero.users (creates library)
            $res2 = $mysqli->query("SELECT COALESCE(MAX(libraryID), 0) + 1 as nextLibID FROM libraries");
            $nextLibID = $res2->fetch_assoc()['nextLibID'];
            $mysqli->query(
                "INSERT INTO libraries (libraryID, libraryType, lastUpdated, version, shardID, hasData)
                 VALUES ($nextLibID, 'user', NOW(), 0, 1, 0)"
            );
            $mysqli->query(
                "INSERT INTO users (userID, libraryID, username) VALUES ($nextID, $nextLibID, '$username')"
            );
            // Generate API key
            $apiKey = bin2hex(random_bytes(12));
            $mysqli->query(
                "INSERT INTO `keys` (`key`, userID, name) VALUES ('$apiKey', $nextID, 'auto-generated')"
            );
            $success = "User <strong>$username</strong> registered! API Key: <code>$apiKey</code>";
        }
    }
}
$mysqli->close();
?>
<!DOCTYPE html>
<html>
<head>
<title>Zotero Local - Register</title>
<style>
body { font-family: sans-serif; max-width: 500px; margin: 50px auto; padding: 20px; }
input { width: 100%; padding: 8px; margin: 5px 0; box-sizing: border-box; }
button { padding: 10px 20px; background: #4677b5; color: white; border: none; cursor: pointer; width: 100%; }
button:hover { background: #3a6599; }
.error { color: red; background: #ffe0e0; padding: 10px; border-radius: 4px; }
.success { color: green; background: #e0ffe0; padding: 10px; border-radius: 4px; }
code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; }
</style>
</head>
<body>
<h2>Zotero Local - Register</h2>
<?php if ($error): ?><div class="error"><?= htmlspecialchars($error) ?></div><?php endif; ?>
<?php if ($success): ?><div class="success"><?= $success ?></div><?php endif; ?>
<form method="post">
  <input name="username" placeholder="Username" required>
  <input name="password" type="password" placeholder="Password (min 8 chars)" required>
  <input name="password2" type="password" placeholder="Confirm password" required>
  <button type="submit">Register</button>
</form>
<p style="color:#888;font-size:small">Already have an account? Use the API Key in your Zotero client sync settings.</p>
</body>
</html>
