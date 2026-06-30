<?php
/**
 * Group management for Zotero local dataserver.
 * Create groups, add/remove members, change roles, modify permissions.
 * No auth required — protect this behind a reverse proxy if needed.
 */

header('Content-Type: text/html; charset=utf-8');

$host = getenv('DB_HOST') ?: '127.0.0.1';
$port = (int)(getenv('DB_PORT') ?: 3306);
$user = getenv('DB_USER') ?: 'zotero';
$pass = getenv('DB_PASS') ?: 'zotropass';

$mysqli = new mysqli($host, $user, $pass, 'zotero', $port);
if ($mysqli->connect_error) {
    die("DB error: " . $mysqli->connect_error);
}

$error = '';
$success = '';

// ── Handle POST actions ────────────────────────────────────────────────────────

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $_POST['action'] ?? '';

    // ── Create group ────────────────────────────────────────────────────────
    if ($action === 'create_group') {
        $name = trim($_POST['name'] ?? '');
        $type = $_POST['type'] ?? 'Private';
        $libEditing = $_POST['libraryEditing'] ?? 'members';
        $libReading = $_POST['libraryReading'] ?? 'all';
        $fileEditing = $_POST['fileEditing'] ?? 'members';
        $desc = trim($_POST['description'] ?? '');
        $ownerUsername = trim($_POST['owner'] ?? '');

        if (!$name) {
            $error = "Group name is required";
        } elseif (!$ownerUsername) {
            $error = "Owner username is required";
        } else {
            // Resolve owner userID
            $stmt = $mysqli->prepare("SELECT userID FROM www.users WHERE username = ?");
            $stmt->bind_param('s', $ownerUsername);
            $stmt->execute();
            $ownerRow = $stmt->get_result()->fetch_assoc();
            $stmt->close();

            if (!$ownerRow) {
                $error = "User '$ownerUsername' not found";
            } else {
                $ownerID = (int)$ownerRow['userID'];

                // Auto-generate slug from name
                $slug = strtolower(preg_replace('/[^a-zA-Z0-9]+/', '-', $name));
                $slug = trim($slug, '-');
                if (!$slug) $slug = 'group-' . time();

                // Check slug unique
                $stmt = $mysqli->prepare("SELECT groupID FROM `groups` WHERE slug = ?");
                $stmt->bind_param('s', $slug);
                $stmt->execute();
                if ($stmt->get_result()->fetch_assoc()) {
                    $slug .= '-' . time();
                }
                $stmt->close();

                $mysqli->begin_transaction();
                try {
                    // Insert library
                    $stmt = $mysqli->prepare(
                        "INSERT INTO libraries (libraryType, lastUpdated, version, shardID, hasData)
                         VALUES ('group', NOW(), 0, 1, 0)"
                    );
                    $stmt->execute();
                    $libraryID = $mysqli->insert_id;
                    $stmt->close();

                    // Insert group
                    $stmt = $mysqli->prepare(
                        "INSERT INTO `groups` (libraryID, name, slug, type, libraryEditing, libraryReading, fileEditing, description, dateModified, version)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), 1)"
                    );
                    $stmt->bind_param('isssssss', $libraryID, $name, $slug, $type, $libEditing, $libReading, $fileEditing, $desc);
                    $stmt->execute();
                    $groupID = $mysqli->insert_id;
                    $stmt->close();

                    // Add owner as group member
                    $stmt = $mysqli->prepare(
                        "INSERT INTO groupUsers (groupID, userID, role, joined, lastUpdated)
                         VALUES (?, ?, 'owner', NOW(), NOW())"
                    );
                    $stmt->bind_param('ii', $groupID, $ownerID);
                    $stmt->execute();
                    $stmt->close();

                    // Register in shardLibraries
                    $mysqli->query(
                        "INSERT IGNORE INTO shardLibraries (libraryID, libraryType, lastUpdated, version, storageUsage)
                         VALUES ($libraryID, 'group', NOW(), 0, 0)"
                    );

                    $mysqli->commit();
                    $success = "Group <strong>" . htmlspecialchars($name) . "</strong> created! "
                             . "(groupID=$groupID, owner=" . htmlspecialchars($ownerUsername) . ")";
                } catch (Exception $e) {
                    $mysqli->rollback();
                    $error = "Failed to create group: " . $e->getMessage();
                }
            }
        }
    }

    // ── Add member ──────────────────────────────────────────────────────────
    elseif ($action === 'add_member') {
        $groupID = (int)($_POST['groupID'] ?? 0);
        $username = trim($_POST['username'] ?? '');
        $role = $_POST['role'] ?? 'member';

        if (!$groupID || !$username) {
            $error = "Group and username are required";
        } else {
            // Check group exists
            $res = $mysqli->query("SELECT name FROM `groups` WHERE groupID=$groupID");
            $group = $res->fetch_assoc();
            if (!$group) {
                $error = "Group not found";
            } else {
                // Resolve user
                $stmt = $mysqli->prepare("SELECT userID FROM www.users WHERE username = ?");
                $stmt->bind_param('s', $username);
                $stmt->execute();
                $userRow = $stmt->get_result()->fetch_assoc();
                $stmt->close();

                if (!$userRow) {
                    $error = "User '$username' not found. Register first.";
                } else {
                    $userID = (int)$userRow['userID'];

                    // Check not already a member
                    $stmt = $mysqli->prepare("SELECT role FROM groupUsers WHERE groupID=? AND userID=?");
                    $stmt->bind_param('ii', $groupID, $userID);
                    $stmt->execute();
                    $existing = $stmt->get_result()->fetch_assoc();
                    $stmt->close();

                    if ($existing) {
                        $error = "User '$username' is already a member (role: {$existing['role']})";
                    } else {
                        $stmt = $mysqli->prepare(
                            "INSERT INTO groupUsers (groupID, userID, role, joined, lastUpdated) VALUES (?, ?, ?, NOW(), NOW())"
                        );
                        $stmt->bind_param('iis', $groupID, $userID, $role);
                        $stmt->execute();
                        $stmt->close();

                        $success = "Added <strong>$username</strong> to <strong>{$group['name']}</strong> as $role";
                    }
                }
            }
        }
    }

    // ── Remove member ───────────────────────────────────────────────────────
    elseif ($action === 'remove_member') {
        $groupID = (int)($_POST['groupID'] ?? 0);
        $userID = (int)($_POST['userID'] ?? 0);

        // Prevent removing the last owner
        $res = $mysqli->query("SELECT role FROM groupUsers WHERE groupID=$groupID AND userID=$userID");
        $member = $res->fetch_assoc();
        if ($member && $member['role'] === 'owner') {
            $cnt = $mysqli->query("SELECT COUNT(*) as c FROM groupUsers WHERE groupID=$groupID AND role='owner'");
            if ($cnt->fetch_assoc()['c'] <= 1) {
                $error = "Cannot remove the last owner of a group. Transfer ownership first.";
                goto skip_remove;
            }
        }

        $mysqli->query("DELETE FROM groupUsers WHERE groupID=$groupID AND userID=$userID");
        if ($mysqli->errno) {
            $error = "Failed to remove member: " . $mysqli->error;
        } elseif ($mysqli->affected_rows > 0) {
            $success = "Member removed from group";
        } else {
            $error = "Member not found in group";
        }
        skip_remove:
    }

    // ── Change role ─────────────────────────────────────────────────────────
    elseif ($action === 'change_role') {
        $groupID = (int)($_POST['groupID'] ?? 0);
        $userID = (int)($_POST['userID'] ?? 0);
        $role = $_POST['role'] ?? 'member';

        $stmt = $mysqli->prepare(
            "UPDATE groupUsers SET role=?, lastUpdated=NOW() WHERE groupID=? AND userID=?"
        );
        $stmt->bind_param('sii', $role, $groupID, $userID);
        $stmt->execute();
        if ($stmt->errno) {
            $error = "Failed to update role: " . $stmt->error;
        } else {
            $success = "Role updated" . ($mysqli->affected_rows === 0 ? " (unchanged)" : "");
        }
        $stmt->close();
    }

    // ── Update group settings ───────────────────────────────────────────────
    elseif ($action === 'update_settings') {
        $groupID = (int)($_POST['groupID'] ?? 0);
        $libEditing = $_POST['libraryEditing'] ?? 'members';
        $libReading = $_POST['libraryReading'] ?? 'all';
        $fileEditing = $_POST['fileEditing'] ?? 'members';
        $type = $_POST['type'] ?? 'Private';
        $desc = trim($_POST['description'] ?? '');

        $stmt = $mysqli->prepare(
            "UPDATE `groups` SET libraryEditing=?, libraryReading=?, fileEditing=?, type=?, description=?, dateModified=NOW() WHERE groupID=?"
        );
        $stmt->bind_param('sssssi', $libEditing, $libReading, $fileEditing, $type, $desc, $groupID);
        $stmt->execute();
        if ($stmt->errno) {
            $error = "Failed to update settings: " . $stmt->error;
        } else {
            $success = "Group settings updated" . ($mysqli->affected_rows === 0 ? " (unchanged)" : "");
        }
        $stmt->close();
    }
}

// ── Fetch all groups with members ──────────────────────────────────────────────

$groups = $mysqli->query(
    "SELECT g.*, l.lastUpdated as libUpdated, l.version as libVersion,
            (SELECT COUNT(*) FROM groupUsers WHERE groupID=g.groupID) as memberCount
     FROM `groups` g
     JOIN libraries l ON g.libraryID = l.libraryID
     ORDER BY g.groupID"
);

// Fetch members for each group
$groupMembers = [];
$allUsers = [];
$usersRes = $mysqli->query("SELECT u.userID, u.username FROM www.users u ORDER BY u.username");
while ($u = $usersRes->fetch_assoc()) {
    $allUsers[] = $u;
}

$membersRes = $mysqli->query(
    "SELECT gu.groupID, gu.userID, gu.role, gu.joined, u.username
     FROM groupUsers gu
     JOIN www.users u ON gu.userID = u.userID
     ORDER BY gu.groupID, FIELD(gu.role, 'owner', 'admin', 'member'), gu.joined"
);
while ($m = $membersRes->fetch_assoc()) {
    $groupMembers[$m['groupID']][] = $m;
}

$mysqli->close();
?>
<!DOCTYPE html>
<html>
<head>
<title>Zotero Local - Group Management</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body { font-family: sans-serif; max-width: 800px; margin: 20px auto; padding: 20px; }
h2 { color: #4677b5; }
h3 { color: #555; border-bottom: 1px solid #eee; padding-bottom: 5px; }
input, select, textarea { width: 100%; padding: 8px; margin: 4px 0; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px; }
textarea { resize: vertical; }
button { padding: 10px 20px; background: #4677b5; color: white; border: none; border-radius: 4px; cursor: pointer; }
button:hover { background: #3a6599; }
button.danger { background: #c44; }
button.danger:hover { background: #a33; }
button.small { padding: 4px 10px; font-size: 12px; }
.error { color: red; background: #ffe0e0; padding: 10px; border-radius: 4px; margin-bottom: 10px; }
.success { color: green; background: #e0ffe0; padding: 10px; border-radius: 4px; margin-bottom: 10px; }
.group-card { border: 1px solid #ddd; border-radius: 8px; padding: 15px; margin: 15px 0; }
.group-card h3 { margin-top: 0; }
.meta { font-size: 13px; color: #666; }
.meta span { margin-right: 15px; }
.member-list { margin-top: 10px; }
.member-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 14px; }
.member-row .name { flex: 1; }
.role-badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: bold; }
.role-owner { background: #ffd700; color: #333; }
.role-admin { background: #fd9; color: #333; }
.role-member { background: #ddf; color: #333; }
.form-row { display: flex; gap: 10px; align-items: end; }
.form-row > * { flex: 1; }
.form-row button { flex: 0 0 auto; }
.inline-form { display: inline; }
details { margin: 8px 0; }
summary { cursor: pointer; color: #4677b5; }
hr { border: none; border-top: 1px solid #eee; margin: 20px 0; }
.note { color: #888; font-size: small; }
nav { margin-bottom: 20px; }
nav a { margin-right: 15px; color: #4677b5; text-decoration: none; }
nav a:hover { text-decoration: underline; }
.tab-bar { display: flex; gap: 10px; margin-bottom: 20px; }
.tab-bar a { padding: 8px 16px; background: #eee; border-radius: 4px; text-decoration: none; color: #333; }
.tab-bar a.active { background: #4677b5; color: white; }
</style>
</head>
<body>

<nav>
  <a href="/auth/register.php">Register</a>
  <a href="/auth/login.php">Login</a>
  <strong>Groups</strong>
</nav>

<h2>📁 Group Management</h2>

<?php if ($error): ?><div class="error"><?= htmlspecialchars($error) ?></div><?php endif; ?>
<?php if ($success): ?><div class="success"><?= $success ?></div><?php endif; ?>

<!-- ── Existing Groups ─────────────────────────────────────────────────────── -->

<h3>Existing Groups</h3>

<?php
$hasGroups = false;
while ($g = $groups->fetch_assoc()):
    $hasGroups = true;
    $gid = $g['groupID'];
    $members = $groupMembers[$gid] ?? [];
?>
<div class="group-card">
  <h3><?= htmlspecialchars($g['name']) ?> <span style="font-size:14px;color:#888">(<?= htmlspecialchars($g['slug']) ?>)</span></h3>
  <div class="meta">
    <span>ID: <?= $gid ?></span>
    <span>Library: <?= $g['libraryID'] ?></span>
    <span>Type: <strong><?= htmlspecialchars($g['type']) ?></strong></span>
    <span>Members: <?= count($members) ?></span>
  </div>

  <!-- Permissions -->
  <div class="meta" style="margin-top:4px">
    <span>Library editing: <?= htmlspecialchars($g['libraryEditing']) ?></span>
    <span>Library reading: <?= htmlspecialchars($g['libraryReading']) ?></span>
    <span>File editing: <?= htmlspecialchars($g['fileEditing']) ?></span>
  </div>

  <!-- Members -->
  <details>
    <summary>Members (<?= count($members) ?>)</summary>
    <div class="member-list">
    <?php foreach ($members as $m): ?>
      <div class="member-row">
        <span class="name"><?= htmlspecialchars($m['username']) ?></span>
        <span class="role-badge role-<?= $m['role'] ?>"><?= $m['role'] ?></span>
        <span style="font-size:11px;color:#aaa">joined <?= substr($m['joined'], 0, 10) ?></span>

        <!-- Change role -->
        <form method="post" class="inline-form" style="display:inline">
          <input type="hidden" name="action" value="change_role">
          <input type="hidden" name="groupID" value="<?= $gid ?>">
          <input type="hidden" name="userID" value="<?= $m['userID'] ?>">
          <select name="role" onchange="this.form.submit()" style="width:auto;padding:2px 4px;font-size:12px">
            <option value="owner"  <?= $m['role']==='owner'?'selected':'' ?>>owner</option>
            <option value="admin"  <?= $m['role']==='admin'?'selected':'' ?>>admin</option>
            <option value="member" <?= $m['role']==='member'?'selected':'' ?>>member</option>
          </select>
        </form>

        <!-- Remove -->
        <form method="post" class="inline-form" style="display:inline"
              onsubmit="return confirm('Remove <?= htmlspecialchars($m['username']) ?> from this group?')">
          <input type="hidden" name="action" value="remove_member">
          <input type="hidden" name="groupID" value="<?= $gid ?>">
          <input type="hidden" name="userID" value="<?= $m['userID'] ?>">
          <button type="submit" class="danger small" style="padding:1px 8px">✕</button>
        </form>
      </div>
    <?php endforeach; ?>
    </div>

    <!-- Add member to this group -->
    <form method="post" style="margin-top:8px">
      <input type="hidden" name="action" value="add_member">
      <input type="hidden" name="groupID" value="<?= $gid ?>">
      <div class="form-row">
        <select name="username" required>
          <option value="">-- Add user --</option>
          <?php
          $existingIDs = array_column($members, 'userID');
          foreach ($allUsers as $u):
              if (in_array($u['userID'], $existingIDs)) continue;
          ?>
          <option value="<?= htmlspecialchars($u['username']) ?>"><?= htmlspecialchars($u['username']) ?></option>
          <?php endforeach; ?>
        </select>
        <select name="role">
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit" class="small">Add</button>
      </div>
    </form>
  </details>

  <!-- Update settings -->
  <details>
    <summary>⚙ Settings</summary>
    <form method="post" style="margin-top:8px">
      <input type="hidden" name="action" value="update_settings">
      <input type="hidden" name="groupID" value="<?= $gid ?>">
      <div class="form-row">
        <label>Type
          <select name="type">
            <option value="Private"      <?= $g['type']==='Private'?'selected':'' ?>>Private</option>
            <option value="PublicClosed" <?= $g['type']==='PublicClosed'?'selected':'' ?>>PublicClosed</option>
            <option value="PublicOpen"   <?= $g['type']==='PublicOpen'?'selected':'' ?>>PublicOpen</option>
          </select>
        </label>
        <label>Library Editing
          <select name="libraryEditing">
            <option value="members" <?= $g['libraryEditing']==='members'?'selected':'' ?>>members</option>
            <option value="admins"  <?= $g['libraryEditing']==='admins'?'selected':'' ?>>admins</option>
          </select>
        </label>
        <label>Library Reading
          <select name="libraryReading">
            <option value="all"     <?= $g['libraryReading']==='all'?'selected':'' ?>>all</option>
            <option value="members" <?= $g['libraryReading']==='members'?'selected':'' ?>>members</option>
          </select>
        </label>
        <label>File Editing
          <select name="fileEditing">
            <option value="members" <?= $g['fileEditing']==='members'?'selected':'' ?>>members</option>
            <option value="admins"  <?= $g['fileEditing']==='admins'?'selected':'' ?>>admins</option>
            <option value="none"    <?= $g['fileEditing']==='none'?'selected':'' ?>>none</option>
          </select>
        </label>
      </div>
      <label style="margin-top:6px">Description
        <input name="description" value="<?= htmlspecialchars($g['description']) ?>">
      </label>
      <button type="submit" class="small" style="margin-top:6px">Update Settings</button>
    </form>
  </details>
</div>
<?php endwhile; ?>

<?php if (!$hasGroups): ?>
<p style="color:#888">No groups yet. Create one below.</p>
<?php endif; ?>

<hr>

<!-- ── Create New Group ────────────────────────────────────────────────────── -->

<h3>➕ Create New Group</h3>
<form method="post">
  <input type="hidden" name="action" value="create_group">

  <div class="form-row">
    <label>Group Name *
      <input name="name" placeholder="My Research Group" required>
    </label>
    <label>Owner Username *
      <select name="owner" required>
        <option value="">-- Select owner --</option>
        <?php foreach ($allUsers as $u): ?>
        <option value="<?= htmlspecialchars($u['username']) ?>"><?= htmlspecialchars($u['username']) ?></option>
        <?php endforeach; ?>
      </select>
    </label>
  </div>

  <div class="form-row" style="margin-top:8px">
    <label>Type
      <select name="type">
        <option value="Private">Private</option>
        <option value="PublicClosed">PublicClosed</option>
        <option value="PublicOpen">PublicOpen</option>
      </select>
    </label>
    <label>Library Editing
      <select name="libraryEditing">
        <option value="members">members</option>
        <option value="admins">admins</option>
      </select>
    </label>
    <label>Library Reading
      <select name="libraryReading">
        <option value="all">all</option>
        <option value="members">members</option>
      </select>
    </label>
    <label>File Editing
      <select name="fileEditing">
        <option value="members">members</option>
        <option value="admins">admins</option>
        <option value="none">none</option>
      </select>
    </label>
  </div>

  <label style="margin-top:8px">Description
    <input name="description" placeholder="Optional description">
  </label>

  <button type="submit" style="margin-top:10px">Create Group</button>
</form>

<hr>
<p class="note">
  Groups appear in the Zotero client under "Group Libraries".
  After creating a group and adding members, each member needs to
  <a href="/auth/login.php">log in</a> to get an API key with group access.
</p>

</body>
</html>
