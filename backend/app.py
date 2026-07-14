"""
GSV Hostel RoomMatch — backend API
-----------------------------------
A small Flask + SQLite backend that gives every student (all 102, on any
device/browser) a shared view of the directory, duos, trios and requests —
something plain localStorage/window.storage can't do once this is hosted
outside Claude.ai.

Run:
    pip install -r requirements.txt
    python app.py
The API listens on http://localhost:5000 by default.
"""

import csv
import io
import os
import sqlite3
import time
import uuid

from flask import Flask, g, jsonify, request, send_file
from flask_cors import CORS

from seed_data import REAL_STUDENTS

DB_PATH = os.path.join(os.path.dirname(__file__), "gsv_hostel.db")
ADMIN_PASSWORD = os.environ.get("GSV_ADMIN_PASSWORD", "gsv-admin-2026")

app = Flask(__name__)
CORS(app)  # allow the static frontend (served from anywhere) to call this API


# --------------------------------------------------------------------------
# DB helpers
# --------------------------------------------------------------------------

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    first_run = not os.path.exists(DB_PATH)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS students (
            roll_number TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            branch TEXT NOT NULL,
            cgpa REAL,
            password TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'looking',
            group_id TEXT
        );

        CREATE TABLE IF NOT EXISTS groups_ (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            locked INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS group_members (
            group_id TEXT NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
            roll_number TEXT NOT NULL REFERENCES students(roll_number) ON DELETE CASCADE,
            seq INTEGER NOT NULL DEFAULT 0,  -- 0/1 = the original duo, 2 = the third roommate who joined later
            PRIMARY KEY (group_id, roll_number)
        );

        CREATE TABLE IF NOT EXISTS requests (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,             -- 'duo_invite' | 'join_duo' | 'trio_invite' | 'unlock_trio'
            from_roll TEXT NOT NULL,
            from_name TEXT NOT NULL,
            to_roll TEXT,                   -- used by duo_invite, trio_invite
            to_name TEXT,
            target_group_id TEXT,           -- used by join_duo, trio_invite, unlock_trio
            message TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            -- trio_invite uses 'pending_partner' (waiting on the other duo
            -- member to approve the proposal) then 'pending_target' (waiting
            -- on the invited student) before 'accepted'/'rejected'.
            timestamp INTEGER NOT NULL
        );

        -- Per-member approval tracking for join_duo/trio_invite/unlock_trio
        -- requests: these only complete once every required member has
        -- accepted. Any one of them rejecting rejects the whole request.
        CREATE TABLE IF NOT EXISTS request_approvals (
            request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
            roll_number TEXT NOT NULL,
            decision TEXT NOT NULL,          -- 'accepted' | 'rejected'
            PRIMARY KEY (request_id, roll_number)
        );

        -- Inbox of one-way notices ("X accepted your invite", "Y left your
        -- trio", etc.) separate from the actionable `requests` above.
        CREATE TABLE IF NOT EXISTS notifications (
            id TEXT PRIMARY KEY,
            roll_number TEXT NOT NULL REFERENCES students(roll_number) ON DELETE CASCADE,
            message TEXT NOT NULL,
            is_read INTEGER NOT NULL DEFAULT 0,
            timestamp INTEGER NOT NULL
        );
        """
    )
    if first_run:
        for s in REAL_STUDENTS:
            conn.execute(
                "INSERT INTO students (roll_number, name, branch, cgpa, password, status, group_id) "
                "VALUES (?, ?, ?, ?, ?, 'looking', NULL)",
                (s["roll"], s["name"], s["branch"], s["cgpa"], s["roll"]),
            )
        conn.commit()

    # --- Migrations for DBs created before locking/trio-invite existed ---
    group_cols = [row[1] for row in conn.execute("PRAGMA table_info(groups_)")]
    if "locked" not in group_cols:
        conn.execute("ALTER TABLE groups_ ADD COLUMN locked INTEGER NOT NULL DEFAULT 0")

    member_cols = [row[1] for row in conn.execute("PRAGMA table_info(group_members)")]
    if "seq" not in member_cols:
        conn.execute("ALTER TABLE group_members ADD COLUMN seq INTEGER NOT NULL DEFAULT 0")
        # Backfill seq using existing row order, per group, so any duo/trio
        # created before this migration still gets a sensible "founders vs
        # third roommate" split (0/1 = original duo, 2 = whoever joined later).
        for grow in conn.execute("SELECT id FROM groups_").fetchall():
            members = conn.execute(
                "SELECT rowid FROM group_members WHERE group_id = ? ORDER BY rowid", (grow[0],)
            ).fetchall()
            for i, (rowid,) in enumerate(members):
                conn.execute("UPDATE group_members SET seq = ? WHERE rowid = ?", (i, rowid))
    conn.commit()
    conn.close()


# --------------------------------------------------------------------------
# Serialization helpers
# --------------------------------------------------------------------------

def student_row_to_dict(row):
    return {
        "rollNumber": row["roll_number"],
        "name": row["name"],
        "branch": row["branch"],
        "cgpa": row["cgpa"],
        "status": row["status"],
        "groupId": row["group_id"],
    }


def get_all_students(db):
    rows = db.execute("SELECT * FROM students ORDER BY name").fetchall()
    return [student_row_to_dict(r) for r in rows]


def get_all_groups(db):
    groups = db.execute("SELECT * FROM groups_").fetchall()
    out = []
    for g_ in groups:
        # Ordered by seq so the frontend can treat memberIds[0:2] as the
        # founding duo and memberIds[2] as the third roommate who joined later.
        members = db.execute(
            "SELECT roll_number FROM group_members WHERE group_id = ? ORDER BY seq, rowid", (g_["id"],)
        ).fetchall()
        out.append({
            "id": g_["id"],
            "type": g_["type"],
            "memberIds": [m["roll_number"] for m in members],
            "locked": bool(g_["locked"]),
        })
    return out


def get_request_approvals(db, request_id):
    rows = db.execute(
        "SELECT roll_number, decision FROM request_approvals WHERE request_id = ?", (request_id,)
    ).fetchall()
    return {r["roll_number"]: r["decision"] for r in rows}


def get_all_requests(db):
    rows = db.execute("SELECT * FROM requests ORDER BY timestamp DESC").fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "type": r["type"],
                "fromRoll": r["from_roll"],
                "fromName": r["from_name"],
                "toRoll": r["to_roll"],
                "toName": r["to_name"],
                "targetGroupId": r["target_group_id"],
                "message": r["message"],
                "status": r["status"],
                "timestamp": r["timestamp"],
                "approvals": get_request_approvals(db, r["id"])
                if r["type"] in ("join_duo", "trio_invite", "unlock_trio")
                else {},
            }
        )
    return out


def add_notification(db, roll_number, message):
    """Queue a one-way notice for a student. Doesn't commit — caller does."""
    if not roll_number:
        return
    db.execute(
        "INSERT INTO notifications (id, roll_number, message, is_read, timestamp) VALUES (?, ?, ?, 0, ?)",
        (str(uuid.uuid4()), roll_number, message, int(time.time() * 1000)),
    )


def full_state():
    db = get_db()
    return {
        "students": get_all_students(db),
        "groups": get_all_groups(db),
        "requests": get_all_requests(db),
    }


def err(message, code=400):
    return jsonify({"error": message}), code


# --------------------------------------------------------------------------
# Read endpoints
# --------------------------------------------------------------------------

@app.route("/api/state", methods=["GET"])
def api_state():
    return jsonify(full_state())


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------

@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json(force=True)
    roll = (data.get("roll") or "").strip()
    password = (data.get("password") or "").strip()
    db = get_db()
    row = db.execute("SELECT * FROM students WHERE roll_number = ?", (roll,)).fetchone()
    if not row:
        return err("Invalid roll number", 401)
    if row["password"] != password:
        return err("Incorrect password", 401)
    return jsonify({"student": student_row_to_dict(row)})


@app.route("/api/admin/login", methods=["POST"])
def api_admin_login():
    data = request.get_json(force=True)
    if data.get("password") != ADMIN_PASSWORD:
        return err("Wrong admin password", 401)
    return jsonify({"ok": True})


@app.route("/api/change-password", methods=["POST"])
def api_change_password():
    data = request.get_json(force=True)
    roll = (data.get("rollNumber") or "").strip()
    current = (data.get("currentPassword") or "").strip()
    new = (data.get("newPassword") or "").strip()
    if not roll:
        return err("Missing roll number")
    if len(new) < 4:
        return err("New password must be at least 4 characters")
    db = get_db()
    row = db.execute("SELECT * FROM students WHERE roll_number = ?", (roll,)).fetchone()
    if not row:
        return err("Invalid student", 404)
    if row["password"] != current:
        return err("Current password is incorrect", 401)
    db.execute("UPDATE students SET password = ? WHERE roll_number = ?", (new, roll))
    db.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# Notifications (one-way notices: invite accepted/rejected, member left, ...)
# --------------------------------------------------------------------------

@app.route("/api/notifications", methods=["GET"])
def api_notifications():
    roll = (request.args.get("roll") or "").strip()
    if not roll:
        return err("Missing roll")
    db = get_db()
    rows = db.execute(
        "SELECT * FROM notifications WHERE roll_number = ? ORDER BY timestamp DESC", (roll,)
    ).fetchall()
    return jsonify({
        "notifications": [
            {"id": r["id"], "message": r["message"], "isRead": bool(r["is_read"]), "timestamp": r["timestamp"]}
            for r in rows
        ]
    })


@app.route("/api/notifications/read-all", methods=["POST"])
def api_notifications_read_all():
    data = request.get_json(force=True)
    roll = data.get("rollNumber")
    db = get_db()
    db.execute("UPDATE notifications SET is_read = 1 WHERE roll_number = ?", (roll,))
    db.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# Requests: invite / join / accept / reject
# --------------------------------------------------------------------------

@app.route("/api/invite", methods=["POST"])
def api_invite():
    data = request.get_json(force=True)
    from_roll, to_roll, message = data.get("fromRoll"), data.get("toRoll"), (data.get("message") or "")
    db = get_db()
    a = db.execute("SELECT * FROM students WHERE roll_number = ?", (from_roll,)).fetchone()
    b = db.execute("SELECT * FROM students WHERE roll_number = ?", (to_roll,)).fetchone()
    if not a or not b:
        return err("Invalid student")
    if a["status"] != "looking":
        return err("You're already in a group")
    if b["status"] != "looking":
        return err("That student already has roommates")
    dup = db.execute(
        "SELECT 1 FROM requests WHERE type='duo_invite' AND from_roll=? AND to_roll=? AND status='pending'",
        (from_roll, to_roll),
    ).fetchone()
    if dup:
        return err("You already invited them")
    rid = str(uuid.uuid4())
    db.execute(
        "INSERT INTO requests (id, type, from_roll, from_name, to_roll, to_name, message, status, timestamp) "
        "VALUES (?, 'duo_invite', ?, ?, ?, ?, ?, 'pending', ?)",
        (rid, a["roll_number"], a["name"], b["roll_number"], b["name"], message, int(time.time() * 1000)),
    )
    db.commit()
    return jsonify({"ok": True, "requestId": rid})


@app.route("/api/join-request", methods=["POST"])
def api_join_request():
    data = request.get_json(force=True)
    group_id = data.get("targetGroupId")
    from_roll = data.get("rollNumber")
    name = data.get("name") or ""
    message = data.get("message") or ""
    db = get_db()
    applicant = db.execute("SELECT * FROM students WHERE roll_number = ?", (from_roll,)).fetchone()
    if not applicant:
        return err("Invalid roll number")
    if applicant["status"] != "looking":
        return err("You're already in a group")
    group = db.execute("SELECT * FROM groups_ WHERE id = ?", (group_id,)).fetchone()
    if not group:
        return err("That duo no longer exists")
    dup = db.execute(
        "SELECT 1 FROM requests WHERE type='join_duo' AND target_group_id=? AND from_roll=? AND status='pending'",
        (group_id, from_roll),
    ).fetchone()
    if dup:
        return err("You already requested to join this duo")
    rid = str(uuid.uuid4())
    db.execute(
        "INSERT INTO requests (id, type, from_roll, from_name, target_group_id, message, status, timestamp) "
        "VALUES (?, 'join_duo', ?, ?, ?, ?, 'pending', ?)",
        (rid, from_roll, name or applicant["name"], group_id, message, int(time.time() * 1000)),
    )
    db.commit()
    return jsonify({"ok": True, "requestId": rid})


@app.route("/api/trio-invite", methods=["POST"])
def api_trio_invite():
    """A duo member invites a third student directly. This does NOT go to
    the invited student right away — it first goes to the other duo member
    as a proposal. Only once they approve does the invite reach the target
    student, and only once the target accepts does the trio actually form.
    """
    data = request.get_json(force=True)
    from_roll, to_roll, message = data.get("fromRoll"), data.get("toRoll"), (data.get("message") or "")
    db = get_db()
    initiator = db.execute("SELECT * FROM students WHERE roll_number = ?", (from_roll,)).fetchone()
    target = db.execute("SELECT * FROM students WHERE roll_number = ?", (to_roll,)).fetchone()
    if not initiator or not target:
        return err("Invalid student")
    if initiator["status"] != "duo" or not initiator["group_id"]:
        return err("You need to be in a duo to invite a third roommate")
    group = db.execute("SELECT * FROM groups_ WHERE id = ?", (initiator["group_id"],)).fetchone()
    if not group or group["type"] != "duo":
        return err("Your group isn't an open duo")
    if group["locked"]:
        return err("Your duo is locked")
    if target["status"] != "looking":
        return err("That student already has roommates")
    if target["roll_number"] == from_roll:
        return err("Invalid student")

    members = [m["roll_number"] for m in db.execute(
        "SELECT roll_number FROM group_members WHERE group_id=? ORDER BY seq", (group["id"],)
    ).fetchall()]
    dup = db.execute(
        "SELECT 1 FROM requests WHERE type='trio_invite' AND target_group_id=? "
        "AND status IN ('pending_partner', 'pending_target')",
        (group["id"],),
    ).fetchone()
    if dup:
        return err("Your duo already has a pending trio invite")

    rid = str(uuid.uuid4())
    db.execute(
        "INSERT INTO requests (id, type, from_roll, from_name, to_roll, to_name, target_group_id, message, status, timestamp) "
        "VALUES (?, 'trio_invite', ?, ?, ?, ?, ?, ?, 'pending_partner', ?)",
        (rid, initiator["roll_number"], initiator["name"], target["roll_number"], target["name"], group["id"], message, int(time.time() * 1000)),
    )
    # The initiator's own approval is implicit — record it right away so the
    # request only needs the OTHER duo member's approval to move forward.
    db.execute(
        "INSERT INTO request_approvals (request_id, roll_number, decision) VALUES (?, ?, 'accepted')",
        (rid, from_roll),
    )
    for m in members:
        if m != from_roll:
            add_notification(
                db, m,
                f"{initiator['name']} wants to invite {target['name']} to join your trio — approve or reject.",
            )
    db.commit()
    return jsonify({"ok": True, "requestId": rid})


def _reject_conflicting(db, rolls, keep_id, extra_group_id=None):
    q = (
        "UPDATE requests SET status='rejected' "
        "WHERE status IN ('pending', 'pending_partner', 'pending_target') AND id != ? AND ("
    )
    clauses, params = [], [keep_id]
    for r in rolls:
        clauses.append("from_roll = ? OR to_roll = ?")
        params += [r, r]
    if extra_group_id:
        clauses.append("target_group_id = ?")
        params.append(extra_group_id)
    q += " OR ".join(clauses) + ")"
    db.execute(q, params)


@app.route("/api/requests/<req_id>/accept", methods=["POST"])
def api_accept(req_id):
    data = request.get_json(force=True) or {}
    acting_roll = data.get("actingRoll")
    db = get_db()
    req = db.execute("SELECT * FROM requests WHERE id = ?", (req_id,)).fetchone()
    if not req or req["status"] not in ("pending", "pending_partner", "pending_target"):
        return err("This request is no longer valid")

    if req["type"] == "duo_invite":
        if acting_roll != req["to_roll"]:
            return err("You can't accept this request", 403)
        a = db.execute("SELECT * FROM students WHERE roll_number = ?", (req["from_roll"],)).fetchone()
        b = db.execute("SELECT * FROM students WHERE roll_number = ?", (req["to_roll"],)).fetchone()
        if not a or not b or a["status"] != "looking" or b["status"] != "looking":
            return err("This invite is no longer valid")
        gid = f"duo-{uuid.uuid4()}"
        db.execute("INSERT INTO groups_ (id, type, locked) VALUES (?, 'duo', 0)", (gid,))
        for i, roll in enumerate((a["roll_number"], b["roll_number"])):
            db.execute("INSERT INTO group_members (group_id, roll_number, seq) VALUES (?, ?, ?)", (gid, roll, i))
            db.execute("UPDATE students SET status='duo', group_id=? WHERE roll_number=?", (gid, roll))
        db.execute("UPDATE requests SET status='accepted' WHERE id=?", (req_id,))
        _reject_conflicting(db, [a["roll_number"], b["roll_number"]], req_id)
        add_notification(db, a["roll_number"], f"{b['name']} accepted your duo invite! You're now roommates.")
        db.commit()
        return jsonify({"ok": True, "groupId": gid})

    if req["type"] == "join_duo":
        group = db.execute("SELECT * FROM groups_ WHERE id = ?", (req["target_group_id"],)).fetchone()
        if not group:
            return err("This request is no longer valid")
        members = [m["roll_number"] for m in db.execute(
            "SELECT roll_number FROM group_members WHERE group_id=?", (group["id"],)
        ).fetchall()]
        if acting_roll not in members:
            return err("You can't accept this request", 403)
        if len(members) >= 3:
            return err("This trio is already complete")
        applicant = db.execute("SELECT * FROM students WHERE roll_number = ?", (req["from_roll"],)).fetchone()
        if not applicant or applicant["status"] != "looking":
            return err("This request is no longer valid")

        already = db.execute(
            "SELECT 1 FROM request_approvals WHERE request_id = ? AND roll_number = ?", (req_id, acting_roll)
        ).fetchone()
        if already:
            return err("You already responded to this request")

        acting_student = db.execute("SELECT * FROM students WHERE roll_number = ?", (acting_roll,)).fetchone()
        db.execute(
            "INSERT INTO request_approvals (request_id, roll_number, decision) VALUES (?, ?, 'accepted')",
            (req_id, acting_roll),
        )

        approvals = get_request_approvals(db, req_id)
        accepted_by = {r for r, d in approvals.items() if d == "accepted"}

        # A trio only forms once EVERY current duo member has accepted.
        if not all(m in accepted_by for m in members):
            for m in members:
                if m != acting_roll:
                    add_notification(
                        db, m,
                        f"{acting_student['name']} accepted {applicant['name']}'s request to join your duo. "
                        f"It still needs your response to complete the trio.",
                    )
            db.commit()
            return jsonify({"ok": True, "waiting": True})

        db.execute("UPDATE groups_ SET type='trio' WHERE id=?", (group["id"],))
        db.execute(
            "INSERT INTO group_members (group_id, roll_number, seq) VALUES (?, ?, 2)",
            (group["id"], applicant["roll_number"]),
        )
        for roll in members + [applicant["roll_number"]]:
            db.execute("UPDATE students SET status='trio', group_id=? WHERE roll_number=?", (group["id"], roll))
        db.execute("UPDATE requests SET status='accepted' WHERE id=?", (req_id,))
        _reject_conflicting(db, [applicant["roll_number"]], req_id, extra_group_id=group["id"])
        add_notification(db, applicant["roll_number"], "Both roommates accepted your request to join! You're now in a trio.")
        db.commit()
        return jsonify({"ok": True, "groupId": group["id"]})

    if req["type"] == "trio_invite":
        group = db.execute("SELECT * FROM groups_ WHERE id = ?", (req["target_group_id"],)).fetchone()
        if not group:
            return err("This request is no longer valid")
        members = [m["roll_number"] for m in db.execute(
            "SELECT roll_number FROM group_members WHERE group_id=? ORDER BY seq", (group["id"],)
        ).fetchall()]

        if req["status"] == "pending_partner":
            # The other duo member is approving the proposal before the
            # invited student ever sees it.
            if acting_roll not in members or acting_roll == req["from_roll"]:
                return err("You can't respond to this proposal", 403)
            already = db.execute(
                "SELECT 1 FROM request_approvals WHERE request_id = ? AND roll_number = ?", (req_id, acting_roll)
            ).fetchone()
            if already:
                return err("You already responded to this proposal")
            db.execute(
                "INSERT INTO request_approvals (request_id, roll_number, decision) VALUES (?, ?, 'accepted')",
                (req_id, acting_roll),
            )
            approvals = get_request_approvals(db, req_id)
            accepted_by = {r for r, d in approvals.items() if d == "accepted"}
            if not all(m in accepted_by for m in members):
                db.commit()
                return jsonify({"ok": True, "waiting": True})

            target = db.execute("SELECT * FROM students WHERE roll_number = ?", (req["to_roll"],)).fetchone()
            if not target or target["status"] != "looking":
                db.execute("UPDATE requests SET status='rejected' WHERE id=?", (req_id,))
                for m in members:
                    add_notification(db, m, f"{req['to_name']} is no longer available — the trio invite was cancelled.")
                db.commit()
                return jsonify({"ok": True, "cancelled": True})

            db.execute("UPDATE requests SET status='pending_target' WHERE id=?", (req_id,))
            members_names = " and ".join(
                s["name"] for s in [db.execute("SELECT * FROM students WHERE roll_number=?", (m,)).fetchone() for m in members]
            )
            add_notification(
                db, req["to_roll"],
                f"{members_names} invited you to join their trio!",
            )
            db.commit()
            return jsonify({"ok": True, "waiting": False, "sentToTarget": True})

        if req["status"] == "pending_target":
            # The invited student is accepting the (now-approved) invite.
            if acting_roll != req["to_roll"]:
                return err("You can't accept this request", 403)
            if len(members) >= 3:
                return err("This trio is already complete")
            target = db.execute("SELECT * FROM students WHERE roll_number = ?", (acting_roll,)).fetchone()
            if not target or target["status"] != "looking":
                return err("This request is no longer valid")
            db.execute("UPDATE groups_ SET type='trio' WHERE id=?", (group["id"],))
            db.execute(
                "INSERT INTO group_members (group_id, roll_number, seq) VALUES (?, ?, 2)",
                (group["id"], target["roll_number"]),
            )
            for roll in members + [target["roll_number"]]:
                db.execute("UPDATE students SET status='trio', group_id=? WHERE roll_number=?", (group["id"], roll))
            db.execute("UPDATE requests SET status='accepted' WHERE id=?", (req_id,))
            _reject_conflicting(db, [target["roll_number"]], req_id, extra_group_id=group["id"])
            for m in members:
                add_notification(db, m, f"{target['name']} accepted your invite! Your trio is complete.")
            db.commit()
            return jsonify({"ok": True, "groupId": group["id"]})

        return err("This request is no longer valid")

    if req["type"] == "unlock_trio":
        members = [m["roll_number"] for m in db.execute(
            "SELECT roll_number FROM group_members WHERE group_id=?", (req["target_group_id"],)
        ).fetchall()]
        if acting_roll not in members:
            return err("You can't respond to this request", 403)
        already = db.execute(
            "SELECT 1 FROM request_approvals WHERE request_id = ? AND roll_number = ?", (req_id, acting_roll)
        ).fetchone()
        if already:
            return err("You already responded to this request")
        db.execute(
            "INSERT INTO request_approvals (request_id, roll_number, decision) VALUES (?, ?, 'accepted')",
            (req_id, acting_roll),
        )
        approvals = get_request_approvals(db, req_id)
        accepted_by = {r for r, d in approvals.items() if d == "accepted"}
        if all(m in accepted_by for m in members):
            db.execute("UPDATE groups_ SET locked=0 WHERE id=?", (req["target_group_id"],))
            db.execute("UPDATE requests SET status='accepted' WHERE id=?", (req_id,))
            for m in members:
                add_notification(db, m, "Everyone agreed — your trio is now unlocked.")
            db.commit()
            return jsonify({"ok": True, "unlocked": True})
        db.commit()
        return jsonify({"ok": True, "waiting": True})

    return err("Unknown request type")


@app.route("/api/requests/<req_id>/reject", methods=["POST"])
def api_reject(req_id):
    data = request.get_json(force=True) or {}
    acting_roll = data.get("actingRoll")
    db = get_db()
    req = db.execute("SELECT * FROM requests WHERE id = ?", (req_id,)).fetchone()
    if not req or req["status"] not in ("pending", "pending_partner", "pending_target"):
        return err("This request is no longer valid")

    if req["type"] == "duo_invite":
        if acting_roll and acting_roll != req["to_roll"]:
            return err("You can't reject this request", 403)
        db.execute("UPDATE requests SET status='rejected' WHERE id=?", (req_id,))
        target = db.execute("SELECT * FROM students WHERE roll_number = ?", (req["to_roll"],)).fetchone()
        add_notification(
            db, req["from_roll"],
            f"{target['name'] if target else req['to_name']} declined your duo invite.",
        )
        db.commit()
        return jsonify({"ok": True})

    if req["type"] == "join_duo":
        members = [m["roll_number"] for m in db.execute(
            "SELECT roll_number FROM group_members WHERE group_id=?", (req["target_group_id"],)
        ).fetchall()]
        if acting_roll and members and acting_roll not in members:
            return err("You can't reject this request", 403)
        # Either duo member rejecting is enough to reject the whole request.
        db.execute("UPDATE requests SET status='rejected' WHERE id=?", (req_id,))
        acting_student = db.execute(
            "SELECT * FROM students WHERE roll_number = ?", (acting_roll,)
        ).fetchone() if acting_roll else None
        who = acting_student["name"] if acting_student else "One of the roommates"
        add_notification(db, req["from_roll"], f"{who} declined your request to join the duo.")
        for m in members:
            if m != acting_roll:
                add_notification(db, m, f"{who} declined {req['from_name']}'s request to join your duo.")
        db.commit()
        return jsonify({"ok": True})

    if req["type"] == "trio_invite":
        if req["status"] == "pending_partner":
            members = [m["roll_number"] for m in db.execute(
                "SELECT roll_number FROM group_members WHERE group_id=?", (req["target_group_id"],)
            ).fetchall()]
            if acting_roll and (acting_roll not in members or acting_roll == req["from_roll"]):
                return err("You can't reject this proposal", 403)
            db.execute("UPDATE requests SET status='rejected' WHERE id=?", (req_id,))
            add_notification(
                db, req["from_roll"],
                f"Your roommate declined your proposal to invite {req['to_name']}.",
            )
            db.commit()
            return jsonify({"ok": True})

        if req["status"] == "pending_target":
            if acting_roll and acting_roll != req["to_roll"]:
                return err("You can't reject this request", 403)
            members = [m["roll_number"] for m in db.execute(
                "SELECT roll_number FROM group_members WHERE group_id=?", (req["target_group_id"],)
            ).fetchall()]
            db.execute("UPDATE requests SET status='rejected' WHERE id=?", (req_id,))
            for m in members:
                add_notification(db, m, f"{req['to_name']} declined your trio invite.")
            db.commit()
            return jsonify({"ok": True})

        return err("This request is no longer valid")

    if req["type"] == "unlock_trio":
        members = [m["roll_number"] for m in db.execute(
            "SELECT roll_number FROM group_members WHERE group_id=?", (req["target_group_id"],)
        ).fetchall()]
        if acting_roll and acting_roll not in members:
            return err("You can't reject this request", 403)
        db.execute("UPDATE requests SET status='rejected' WHERE id=?", (req_id,))
        acting_student = db.execute(
            "SELECT * FROM students WHERE roll_number = ?", (acting_roll,)
        ).fetchone() if acting_roll else None
        who = acting_student["name"] if acting_student else "One of your roommates"
        for m in members:
            if m != acting_roll:
                add_notification(db, m, f"{who} rejected the request to unlock your trio. It stays locked.")
        db.commit()
        return jsonify({"ok": True})

    db.execute("UPDATE requests SET status='rejected' WHERE id=?", (req_id,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/leave", methods=["POST"])
def api_leave():
    data = request.get_json(force=True)
    roll = data.get("rollNumber")
    db = get_db()
    student = db.execute("SELECT * FROM students WHERE roll_number = ?", (roll,)).fetchone()
    if not student or not student["group_id"]:
        return err("Not in a group")
    group_id = student["group_id"]
    group = db.execute("SELECT * FROM groups_ WHERE id = ?", (group_id,)).fetchone()
    if group and group["locked"]:
        return err("Your trio is locked. All three of you need to agree to unlock it first — see your trio card.")
    group_type = group["type"] if group else "duo"
    members = [m["roll_number"] for m in db.execute(
        "SELECT roll_number FROM group_members WHERE group_id=?", (group_id,)
    ).fetchall()]
    db.execute("DELETE FROM group_members WHERE group_id=? AND roll_number=?", (group_id, roll))
    db.execute("UPDATE students SET status='looking', group_id=NULL WHERE roll_number=?", (roll,))
    remaining = [m for m in members if m != roll]
    if len(remaining) <= 1:
        db.execute("DELETE FROM groups_ WHERE id=?", (group_id,))
        for m in remaining:
            db.execute("UPDATE students SET status='looking', group_id=NULL WHERE roll_number=?", (m,))
        db.execute("DELETE FROM group_members WHERE group_id=?", (group_id,))
    else:
        db.execute("UPDATE groups_ SET type='duo' WHERE id=?", (group_id,))
        for m in remaining:
            db.execute("UPDATE students SET status='duo', group_id=? WHERE roll_number=?", (group_id, m))
    for m in remaining:
        add_notification(
            db, m,
            f"{student['name']} left your {group_type}. "
            f"{'Your group is now looking for a roommate.' if len(remaining) <= 1 else 'Your trio is now a duo again.'}",
        )
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/groups/<group_id>/lock", methods=["POST"])
def api_lock_group(group_id):
    """Lock a completed trio. Only the original two roommates (the ones who
    formed the duo first — seq 0/1) may do this; the third roommate can't."""
    data = request.get_json(force=True) or {}
    acting_roll = data.get("actingRoll")
    db = get_db()
    group = db.execute("SELECT * FROM groups_ WHERE id = ?", (group_id,)).fetchone()
    if not group:
        return err("Group not found", 404)
    if group["type"] != "trio":
        return err("Only a complete trio can be locked")
    if group["locked"]:
        return err("This trio is already locked")
    founders = [m["roll_number"] for m in db.execute(
        "SELECT roll_number FROM group_members WHERE group_id=? AND seq IN (0, 1)", (group_id,)
    ).fetchall()]
    if acting_roll not in founders:
        return err("Only the original two roommates can lock the trio", 403)
    actor = db.execute("SELECT * FROM students WHERE roll_number=?", (acting_roll,)).fetchone()
    db.execute("UPDATE groups_ SET locked=1 WHERE id=?", (group_id,))
    all_members = [m["roll_number"] for m in db.execute(
        "SELECT roll_number FROM group_members WHERE group_id=?", (group_id,)
    ).fetchall()]
    for m in all_members:
        if m != acting_roll:
            add_notification(db, m, f"{actor['name']} locked your trio. Your room is finalized!")
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/groups/<group_id>/request-unlock", methods=["POST"])
def api_request_unlock(group_id):
    """Any of the three roommates can propose unlocking a locked trio, but it
    only actually unlocks once ALL THREE members have agreed."""
    data = request.get_json(force=True) or {}
    acting_roll = data.get("actingRoll")
    db = get_db()
    group = db.execute("SELECT * FROM groups_ WHERE id = ?", (group_id,)).fetchone()
    if not group:
        return err("Group not found", 404)
    if group["type"] != "trio" or not group["locked"]:
        return err("This trio isn't locked")
    members = [m["roll_number"] for m in db.execute(
        "SELECT roll_number FROM group_members WHERE group_id=?", (group_id,)
    ).fetchall()]
    if acting_roll not in members:
        return err("You're not in this trio", 403)
    dup = db.execute(
        "SELECT 1 FROM requests WHERE type='unlock_trio' AND target_group_id=? AND status='pending'", (group_id,)
    ).fetchone()
    if dup:
        return err("An unlock request is already pending for this trio")
    actor = db.execute("SELECT * FROM students WHERE roll_number=?", (acting_roll,)).fetchone()
    rid = str(uuid.uuid4())
    db.execute(
        "INSERT INTO requests (id, type, from_roll, from_name, target_group_id, message, status, timestamp) "
        "VALUES (?, 'unlock_trio', ?, ?, ?, '', 'pending', ?)",
        (rid, acting_roll, actor["name"], group_id, int(time.time() * 1000)),
    )
    # Proposing unlock counts as that member's own approval.
    db.execute(
        "INSERT INTO request_approvals (request_id, roll_number, decision) VALUES (?, ?, 'accepted')",
        (rid, acting_roll),
    )
    for m in members:
        if m != acting_roll:
            add_notification(db, m, f"{actor['name']} wants to unlock your trio — everyone must agree.")
    db.commit()
    return jsonify({"ok": True, "requestId": rid})


@app.route("/api/profile", methods=["POST"])
def api_profile():
    data = request.get_json(force=True)
    roll, name, branch = data.get("rollNumber"), data.get("name"), data.get("branch")
    db = get_db()
    db.execute("UPDATE students SET name=?, branch=? WHERE roll_number=?", (name, branch, roll))
    db.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# Admin
# --------------------------------------------------------------------------

@app.route("/api/admin/students", methods=["POST"])
def api_admin_add_student():
    data = request.get_json(force=True)
    roll, name, branch = data.get("rollNumber"), data.get("name"), data.get("branch")
    db = get_db()
    if db.execute("SELECT 1 FROM students WHERE roll_number=?", (roll,)).fetchone():
        return err("Duplicate roll number")
    db.execute(
        "INSERT INTO students (roll_number, name, branch, cgpa, password, status, group_id) "
        "VALUES (?, ?, ?, NULL, ?, 'looking', NULL)",
        (roll, name, branch, roll),
    )
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/admin/students/<roll>", methods=["PUT"])
def api_admin_edit_student(roll):
    data = request.get_json(force=True)
    db = get_db()
    fields, params = [], []
    for key, col in (("name", "name"), ("branch", "branch")):
        if key in data:
            fields.append(f"{col} = ?")
            params.append(data[key])
    if fields:
        params.append(roll)
        db.execute(f"UPDATE students SET {', '.join(fields)} WHERE roll_number = ?", params)
        db.commit()
    return jsonify({"ok": True})


@app.route("/api/admin/students/<roll>", methods=["DELETE"])
def api_admin_remove_student(roll):
    db = get_db()
    student = db.execute("SELECT * FROM students WHERE roll_number=?", (roll,)).fetchone()
    if not student:
        return err("Not found", 404)
    if student["group_id"]:
        group_id = student["group_id"]
        members = [m["roll_number"] for m in db.execute(
            "SELECT roll_number FROM group_members WHERE group_id=?", (group_id,)
        ).fetchall()]
        db.execute("DELETE FROM group_members WHERE group_id=? AND roll_number=?", (group_id, roll))
        remaining = [m for m in members if m != roll]
        if len(remaining) <= 1:
            db.execute("DELETE FROM groups_ WHERE id=?", (group_id,))
            db.execute("DELETE FROM group_members WHERE group_id=?", (group_id,))
            db.execute("DELETE FROM requests WHERE target_group_id=?", (group_id,))
            for m in remaining:
                db.execute("UPDATE students SET status='looking', group_id=NULL WHERE roll_number=?", (m,))
        else:
            db.execute("UPDATE groups_ SET type='duo' WHERE id=?", (group_id,))
    db.execute("DELETE FROM requests WHERE from_roll=? OR to_roll=?", (roll, roll))
    db.execute("DELETE FROM students WHERE roll_number=?", (roll,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/admin/groups/<group_id>/dissolve", methods=["POST"])
def api_admin_dissolve_group(group_id):
    db = get_db()
    members = [m["roll_number"] for m in db.execute(
        "SELECT roll_number FROM group_members WHERE group_id=?", (group_id,)
    ).fetchall()]
    for m in members:
        db.execute("UPDATE students SET status='looking', group_id=NULL WHERE roll_number=?", (m,))
    db.execute("DELETE FROM group_members WHERE group_id=?", (group_id,))
    db.execute("DELETE FROM groups_ WHERE id=?", (group_id,))
    db.execute("DELETE FROM requests WHERE target_group_id=?", (group_id,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/admin/requests/<req_id>", methods=["DELETE"])
def api_admin_delete_request(req_id):
    db = get_db()
    db.execute("DELETE FROM requests WHERE id=?", (req_id,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/admin/export.csv", methods=["GET"])
def api_admin_export():
    db = get_db()
    rows = get_all_students(db)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Name", "Roll", "Branch", "CGPA", "Status"])
    for r in rows:
        writer.writerow([r["name"], r["rollNumber"], r["branch"], r["cgpa"], r["status"]])
    mem = io.BytesIO(buf.getvalue().encode("utf-8"))
    return send_file(mem, mimetype="text/csv", as_attachment=True, download_name="gsv-hostel-students.csv")


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=5000, debug=True)
