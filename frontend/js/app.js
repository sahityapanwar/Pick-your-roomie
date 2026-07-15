/* GSV Hostel RoomMatch — frontend
 * Vanilla JS. Talks to the Flask API (see backend/app.py) for all shared
 * data (directory, duos, trios, requests) so every student sees the same
 * live state. Only the theme and "who am I logged in as" are kept locally
 * (localStorage), since those are per-device, not shared.
 */

const API_BASE = (window.GSV_API_BASE) || "https://pick-your-roommate.onrender.com";
const ADMIN_PASSWORD_HINT = "Ask the hostel office for the admin password.";

const STATUS_META = {
  looking: { label: "Looking for roommates", dot: "🟢", cls: "status-looking" },
  duo: { label: "In a Duo", dot: "🟡", cls: "status-duo" },
  trio: { label: "Trio Complete", dot: "🔵", cls: "status-trio" },
};

const FAQS = [
  { q: "Does the hostel office or warden assign our room?", a: "No. There's no hostel office or warden involvement in matching roommates or assigning rooms. You and your two roommates form your trio yourselves on this page, then on move-in day you simply walk into the hostel and pick your favorite available room — strictly first-come, first-served." },
  { q: "What's the difference between GSV Campus Hostel and Stanza Living?", a: "GSV Campus Hostel is triple-sharing and reserved for the top 102 students on the merit list; everyone ranked 103rd or lower starts in Stanza Living, which is double-sharing. You're placed automatically based on your rank — you never choose a hostel yourself, and you'll only ever see students from your own hostel here." },
  { q: "What happens if I can't find roommates in time?", a: "There's no fallback matching by the hostel office — it's entirely on you. If you haven't formed a group by 1 August, you'll still need to walk into the hostel and sort out a room from whatever's left, in person, first-come first-served. Forming your group early is strongly in your own interest." },
  { q: "Can a GSV duo invite a third roommate directly, instead of only waiting for requests?", a: "Yes. Either member of a duo can tap Invite on any looking student's card. It doesn't go out right away — it first goes to the other duo member for approval. Only once your roommate approves does the invited student actually see it and get to accept or reject it." },
  { q: "Who can request to join our duo?", a: "Any student still in 'Looking' status, from your own hostel, can send a request. In GSV, both members of the duo need to accept it before the trio is formed. Stanza duos are double-sharing only, so they don't take a third member." },
  { q: "What does locking mean, and who can do it?", a: "Locking finalizes your room lineup. In GSV, only the original two roommates who formed the duo first can lock a trio — the third roommate who joined later can't — and unlocking afterward needs all three to agree. In Stanza, both members of a duo lock independently; once BOTH have locked, the duo is permanent and can never be changed." },
  { q: "Can I leave a group after joining?", a: "Yes, from your profile — unless it's locked. A locked GSV trio needs all three members to agree to unlock it before anyone can leave; a locked Stanza duo can never be left or changed at all, by design." },
  { q: "I'm in GSV — can I give up my seat?", a: "Yes, from your profile you can Opt Out of GSV Hostel. This is permanent and immediate: you move to Stanza Living right away, and your vacated seat is automatically filled by the highest-ranked student currently waiting." },
  { q: "How does the GSV waiting list work?", a: "Every Stanza student is ranked in a queue. The moment a GSV seat opens up — from an opt-out or otherwise — the single highest-ranked waiting student is promoted into GSV automatically, no approval needed. If that student was already in a locked Stanza duo, it's dissolved and their former roommate goes back to 'Looking'." },
  { q: "Is my roll number really my password?", a: "For this pilot, yes — your roll number is your temporary password. You can log in and change your password, by clicking on the profile icon." },
  { q: "Is this data visible to other students?", a: "Only within your own hostel. GSV students never see Stanza students (or vice versa) — the directory, duos, trios and statistics you see are always scoped to your own hostel." },
];

/* ------------------------------ state ------------------------------ */

const state = {
  theme: localStorage.getItem("gsv_theme") || "light",
  session: JSON.parse(localStorage.getItem("gsv_session") || "null"),
  adminAuthed: sessionStorage.getItem("gsv_admin_authed") === "1",
  students: [],
  groups: [],
  requests: [],
  notifications: [],
  search: "",
  stanzaSearch: "",
  filter: "all",
  view: "home",      // "gate" | "home" (GSV portal) | "stanza" | "admin"
  capacity: null,    // admin-only: capacity + waiting list info
  adminData: null,   // admin-only: full cross-hostel students/groups/requests
};

/* ------------------------------ helpers ----------------------------- */

function initials(name) {
  return name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}
function hueFromString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h) % 360;
}
function avatarStyle(name) {
  const hue = hueFromString(name);
  return `background: linear-gradient(135deg, hsl(${hue},72%,58%), hsl(${(hue + 50) % 360},72%,52%));`;
}
function avatarHTML(name, size) {
  return `<div class="avatar avatar-${size}" style="${avatarStyle(name)}">${initials(name)}</div>`;
}
function timeAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function escapeHTML(str) {
  const d = document.createElement("div");
  d.textContent = str ?? "";
  return d.innerHTML;
}
function studentByRoll(roll) {
  return state.students.find((s) => s.rollNumber === roll);
}
function currentStudent() {
  return state.session ? studentByRoll(state.session.rollNumber) : null;
}

function toast(message) {
  const stack = document.getElementById("toast-stack");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

async function api(path, opts = {}) {
  const res = await fetch(API_BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    throw new Error((data && data.error) || "Something went wrong");
  }
  return data;
}

async function refreshState() {
  if (!state.session) { state.students = []; state.groups = []; state.requests = []; return; }
  const data = await api(`/api/state?roll=${encodeURIComponent(state.session.rollNumber)}`);
  state.students = data.students;
  state.groups = data.groups;
  state.requests = data.requests;
  await refreshNotifications();
  renderAll();
}

async function refreshAdminState() {
  // Full cross-hostel view (GSV + Stanza), plus capacity/waiting-list
  // figures — admin only, gated by the admin password screen.
  const data = await api("/api/admin/state");
  state.adminData = data;
  state.capacity = data.capacity;
}

async function refreshNotifications() {
  if (!state.session) { state.notifications = []; return; }
  try {
    const data = await api(`/api/notifications?roll=${encodeURIComponent(state.session.rollNumber)}`);
    state.notifications = data.notifications;
  } catch (e) { /* non-fatal — leave old notifications in place */ }
}

async function markNotificationsRead() {
  const me = currentStudent();
  if (!me) return;
  try {
    await api("/api/notifications/read-all", { method: "POST", body: JSON.stringify({ rollNumber: me.rollNumber }) });
    state.notifications.forEach((n) => { n.isRead = true; });
    renderNavbar();
  } catch (e) { /* non-fatal */ }
}

/* ------------------------------ modal system ------------------------------ */

function openModal(innerHTML, { wide = false, onMount } = {}) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal-box ${wide ? "wide" : ""}" id="modal-box">${innerHTML}</div>
    </div>`;
  document.getElementById("modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "modal-overlay") closeModal();
  });
  if (onMount) onMount(document.getElementById("modal-box"));
}
function closeModal() {
  document.getElementById("modal-root").innerHTML = "";
}

/* ------------------------------ rendering ------------------------------ */

function renderAll() {
  renderNavbar();
  applyTheme();
  if (state.view === "home") {
    renderStats();
    renderDirectory();
    renderDuos();
    renderTrios();
    renderFAQ();
  } else if (state.view === "stanza") {
    renderStanzaStats();
    renderStanzaLooking();
    renderStanzaDuos();
  } else if (state.view === "admin") {
    renderAdmin();
  }
}

function applyTheme() {
  const root = document.getElementById("app");
  root.classList.toggle("light", state.theme === "light");
  root.classList.toggle("dark", state.theme === "dark");
  document.getElementById("btn-theme").textContent = state.theme === "light" ? "🌙" : "☀️";
}

function pendingRequestsForMe() {
  const me = currentStudent();
  if (!me) return [];
  return state.requests.filter((r) => {
    if (r.type === "duo_invite") return r.status === "pending" && r.toRoll === me.rollNumber;
    if (r.type === "join_duo") {
      if (r.status !== "pending") return false;
      const g = state.groups.find((gr) => gr.id === r.targetGroupId);
      return g && g.memberIds.includes(me.rollNumber);
    }
    if (r.type === "trio_invite") {
      if (r.status === "pending_partner") {
        const g = state.groups.find((gr) => gr.id === r.targetGroupId);
        return g && g.memberIds.includes(me.rollNumber) && me.rollNumber !== r.fromRoll;
      }
      if (r.status === "pending_target") return r.toRoll === me.rollNumber;
      return false;
    }
    if (r.type === "unlock_trio") {
      if (r.status !== "pending") return false;
      const g = state.groups.find((gr) => gr.id === r.targetGroupId);
      return g && g.memberIds.includes(me.rollNumber);
    }
    return false;
  });
}

// Requests that still need MY response — excludes join_duo/trio_invite/
// unlock_trio requests I've already responded to and am just waiting on
// others for.
function actionableRequestsForMe() {
  const me = currentStudent();
  if (!me) return [];
  return pendingRequestsForMe().filter((r) => {
    if (r.type === "join_duo") return !(r.approvals && r.approvals[me.rollNumber]);
    if (r.type === "trio_invite" && r.status === "pending_partner") return !(r.approvals && r.approvals[me.rollNumber]);
    if (r.type === "unlock_trio") return !(r.approvals && r.approvals[me.rollNumber]);
    return true;
  });
}

function renderNavbar() {
  const me = currentStudent();
  const bell = document.getElementById("btn-bell");
  const bellCount = document.getElementById("bell-count");
  const userChip = document.getElementById("user-chip");
  const loginBtn = document.getElementById("btn-login");
  const navGSV = document.getElementById("nav-links");
  const navStanza = document.getElementById("nav-links-stanza");

  navGSV.classList.toggle("hidden", state.view !== "home");
  navStanza.classList.toggle("hidden", state.view !== "stanza");

  if (state.session && state.view !== "gate") {
    bell.classList.remove("hidden");
    const badgeCount = actionableRequestsForMe().length + state.notifications.filter((n) => !n.isRead).length;
    if (badgeCount > 0) {
      bellCount.textContent = badgeCount;
      bellCount.classList.remove("hidden");
    } else {
      bellCount.classList.add("hidden");
    }
    userChip.classList.remove("hidden");
    loginBtn.classList.add("hidden");
    if (me) {
      document.getElementById("user-avatar").outerHTML = avatarHTML(me.name, "sm")
        .replace('class="avatar', 'id="user-avatar" class="avatar clickable-avatar" title="View your profile"');
    }
  } else {
    bell.classList.add("hidden");
    userChip.classList.add("hidden");
    loginBtn.classList.remove("hidden");
  }
}

function renderStats() {
  const total = state.students.length;
  const looking = state.students.filter((s) => s.status === "looking").length;
  const duos = state.groups.filter((g) => g.type === "duo").length;
  const trios = state.groups.filter((g) => g.type === "trio").length;
  const cards = [
    { label: "Total Students", value: total, icon: "👥" },
    { label: "Students Looking", value: looking, icon: "🔎" },
    { label: "Duos Formed", value: duos, icon: "🤝" },
    { label: "Trios Completed", value: trios, icon: "✅" },
  ];
  document.getElementById("stats-grid").innerHTML = cards.map((c) => `
    <div class="card stat-card">
      <div class="stat-icon">${c.icon}</div>
      <div class="stat-value">${c.value}</div>
      <div class="stat-label">${c.label}</div>
    </div>`).join("");
}

function canInvite(student) {
  const me = currentStudent();
  if (!me) return false;
  if (me.status !== "looking" && me.status !== "duo") return false;
  if (student.status !== "looking") return false;
  if (student.rollNumber === me.rollNumber) return false;
  return true;
}

function studentCardHTML(s) {
  const meta = STATUS_META[s.status];
  return `
    <div class="card student-card" data-open-profile="${s.rollNumber}">
      <div class="student-row">
        ${avatarHTML(s.name, "md")}
        <div>
          <div class="student-name">${escapeHTML(s.name)}</div>
          <div class="student-roll mono">${s.rollNumber} · ${s.branch}</div>
        </div>
      </div>
      <div class="card-footer">
        <span class="status-badge ${meta.cls}">${meta.dot} ${meta.label}</span>
        ${canInvite(s) ? `<button class="invite-btn" data-invite="${s.rollNumber}">Invite</button>` : ""}
      </div>
    </div>`;
}

function renderDirectory() {
  const term = state.search.trim().toLowerCase();
  const list = state.students
    .filter((s) => state.filter === "all" || s.status === state.filter)
    .filter((s) => !term || s.name.toLowerCase().includes(term) || s.rollNumber.toLowerCase().includes(term))
    .sort((a, b) => a.name.localeCompare(b.name));

  const grid = document.getElementById("directory-grid");
  if (list.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">No students match your search. Try a different name or roll number.</div>`;
  } else {
    grid.innerHTML = list.map(studentCardHTML).join("");
  }

  document.querySelectorAll("#filter-tabs .filter-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.filter === state.filter);
  });
  document.querySelectorAll(".invite-btn").forEach((btn) => {
    btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        showInviteModal(btn.dataset.invite);
    };
});
}

function renderDuos() {
  const duos = state.groups.filter((g) => g.type === "duo");
  const grid = document.getElementById("duos-grid");
  if (duos.length === 0) {
    grid.innerHTML = `<div class="card" style="grid-column:1/-1" ><div class="empty-state">No duos yet — be the first to invite someone.</div></div>`;
    return;
  }
  const me = currentStudent();
  grid.innerHTML = duos.map((g) => {
    const members = g.memberIds.map(studentByRoll).filter(Boolean);
    const isMyDuo = me && g.memberIds.includes(me.rollNumber);
    const pendingTrioInvite = state.requests.find(
      (r) => r.type === "trio_invite" && r.targetGroupId === g.id && (r.status === "pending_partner" || r.status === "pending_target")
    );
    let actionHTML;
    if (isMyDuo) {
      if (pendingTrioInvite) {
        const stage = pendingTrioInvite.status === "pending_partner"
          ? "Waiting on your roommate to approve"
          : `Invite sent to ${escapeHTML(pendingTrioInvite.toName)} — awaiting their response`;
        actionHTML = `<div class="hint" style="margin-top:0.7rem">⏳ ${stage}</div>`;
      } else {
        actionHTML = `<button class="grad-btn" style="width:100%;margin-top:0.7rem;" data-invite-third="${g.id}">➕ Invite a Roommate</button>`;
      }
    } else {
      actionHTML = `<button class="grad-btn" style="width:100%;margin-top:0.7rem;" data-join-group="${g.id}">Request to Join</button>`;
    }
    return `
      <div class="card duo-card">
        <div class="duo-members">
          ${members.map((m, i) => `
            <button class="member-mini" data-open-profile="${m.rollNumber}">
              ${avatarHTML(m.name, "md")}
              <div><div class="student-name">${escapeHTML(m.name)}</div><div class="student-roll mono">${m.rollNumber}</div></div>
            </button>
            ${i === 0 ? '<span class="dots-link">┄┄</span>' : ""}
          `).join("")}
        </div>
        <span class="need-more">Need 1 More Roommate</span>
        ${actionHTML}
      </div>`;
  }).join("");
}

function renderTrios() {
  const trios = state.groups.filter((g) => g.type === "trio");
  const grid = document.getElementById("trios-grid");
  if (trios.length === 0) {
    grid.innerHTML = `<div class="card" style="grid-column:1/-1"><div class="empty-state">No completed trios yet.</div></div>`;
    return;
  }
  const me = currentStudent();
  grid.innerHTML = trios.map((g) => {
    const members = g.memberIds.map(studentByRoll).filter(Boolean);
    const founders = g.memberIds.slice(0, 2); // seq 0/1 — the original duo
    const isMember = me && g.memberIds.includes(me.rollNumber);
    const canLock = me && !g.locked && founders.includes(me.rollNumber);
    const pendingUnlock = state.requests.find((r) => r.type === "unlock_trio" && r.targetGroupId === g.id && r.status === "pending");

    let actionHTML = "";
    if (g.locked) {
      if (pendingUnlock) {
        const approvedCount = Object.values(pendingUnlock.approvals || {}).filter((d) => d === "accepted").length;
        actionHTML = `<div class="hint" style="margin-top:0.6rem">🔓 Unlock requested — ${approvedCount}/3 agreed</div>`;
      } else if (isMember) {
        actionHTML = `<button class="outline-btn" style="width:100%;margin-top:0.7rem;" data-request-unlock="${g.id}">Request Unlock</button>`;
      }
    } else if (canLock) {
      actionHTML = `<button class="grad-btn" style="width:100%;margin-top:0.7rem;" data-lock-trio="${g.id}">🔒 Lock Trio</button>`;
    } else if (isMember) {
      actionHTML = `<div class="hint" style="margin-top:0.6rem">Only your original two roommates can lock this trio.</div>`;
    }

    return `
      <div class="card trio-card">
        <div class="trio-members">
          ${members.map((m) => `
            <button class="member-mini" data-open-profile="${m.rollNumber}">
              ${avatarHTML(m.name, "sm")}
              <div><div class="student-name">${escapeHTML(m.name)}</div><div class="student-roll mono">${m.rollNumber}</div></div>
            </button>`).join("")}
        </div>
        <div class="trio-done">${g.locked ? "🔒 Trio Locked" : "✅ Trio Completed"}</div>
        ${actionHTML}
      </div>`;
  }).join("");
}

/* ------------------------------ Stanza Living portal ------------------------------ */
// state.students/groups/requests are ALREADY scoped to the logged-in
// student's own hostel by the backend (see /api/state?roll=...), so no
// extra hostel filtering is needed here — a Stanza student's state simply
// never contains any GSV data at all.

function renderStanzaStats() {
  const total = state.students.length;
  const looking = state.students.filter((s) => s.status === "looking").length;
  const duos = state.groups.filter((g) => g.type === "duo").length;
  const locked = state.groups.filter((g) => g.type === "duo" && g.locked).length;
  const cards = [
    { label: "Total Stanza Students", value: total, icon: "👥" },
    { label: "Students Looking", value: looking, icon: "🔎" },
    { label: "Duos Formed", value: duos, icon: "🤝" },
    { label: "Duos Locked", value: locked, icon: "🔒" },
  ];
  document.getElementById("stanza-stats-grid").innerHTML = cards.map((c) => `
    <div class="card stat-card">
      <div class="stat-icon">${c.icon}</div>
      <div class="stat-value">${c.value}</div>
      <div class="stat-label">${c.label}</div>
    </div>`).join("");
}

function renderStanzaLooking() {
  const term = state.stanzaSearch.trim().toLowerCase();
  const list = state.students
    .filter((s) => s.status === "looking")
    .filter((s) => !term || s.name.toLowerCase().includes(term) || s.rollNumber.toLowerCase().includes(term))
    .sort((a, b) => a.name.localeCompare(b.name));
  const grid = document.getElementById("stanza-looking-grid");
  if (list.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">No one is looking for a roommate right now.</div>`;
  } else {
    grid.innerHTML = list.map(studentCardHTML).join("");
  }
  document.querySelectorAll("#stanza-looking-grid .invite-btn").forEach((btn) => {
    btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); showInviteModal(btn.dataset.invite); };
  });
}

function renderStanzaDuos() {
  const duos = state.groups.filter((g) => g.type === "duo");
  const grid = document.getElementById("stanza-duos-grid");
  if (duos.length === 0) {
    grid.innerHTML = `<div class="card" style="grid-column:1/-1"><div class="empty-state">No completed duos yet.</div></div>`;
    return;
  }
  const me = currentStudent();
  grid.innerHTML = duos.map((g) => {
    const members = g.memberIds.map(studentByRoll).filter(Boolean);
    const isMember = me && g.memberIds.includes(me.rollNumber);
    const myApproved = !!(g.lockApprovals && g.lockApprovals[me?.rollNumber]);
    let actionHTML;
    if (g.locked) {
      actionHTML = `<div class="hint" style="margin-top:0.6rem">This room partnership has been finalized and can no longer be changed.</div>`;
    } else if (isMember && myApproved) {
      actionHTML = `<div class="hint" style="margin-top:0.6rem">✓ You agreed to lock — waiting for your roommate.</div>`;
    } else if (isMember) {
      actionHTML = `<button class="grad-btn" style="width:100%;margin-top:0.7rem;" data-stanza-lock="${g.id}">🔒 Lock Duo</button>`;
    }
    return `
      <div class="card duo-card">
        <div class="duo-members">
          ${members.map((m, i) => `
            <button class="member-mini" data-open-profile="${m.rollNumber}">
              ${avatarHTML(m.name, "md")}
              <div><div class="student-name">${escapeHTML(m.name)}</div><div class="student-roll mono">${m.rollNumber}</div></div>
            </button>
            ${i === 0 ? '<span class="dots-link">┄┄</span>' : ""}
          `).join("")}
        </div>
        <div class="trio-done">${g.locked ? "🔒 Locked/Finalized" : "🟡 Unlocked"}</div>
        ${actionHTML || ""}
      </div>`;
  }).join("");
}

function showStanzaLockConfirmModal(groupId) {
  openModal(`
    <h3>Lock this duo?</h3>
    <p class="hint" style="margin:0.5rem 0 1.25rem">Your roommate also needs to lock it independently. Once you BOTH have, this room partnership is finalized and can never be changed — no leaving, no new invitations.</p>
    <div class="modal-actions">
      <button class="outline-btn" id="btn-cancel">Cancel</button>
      <button class="grad-btn" id="btn-confirm">🔒 Lock My Side</button>
    </div>
  `, {
    onMount: (box) => {
      box.querySelector("#btn-cancel").onclick = closeModal;
      box.querySelector("#btn-confirm").onclick = async () => {
        const me = currentStudent();
        try {
          const res = await api(`/api/stanza/groups/${groupId}/lock`, { method: "POST", body: JSON.stringify({ actingRoll: me.rollNumber }) });
          toast(res.locked ? "🔒 Both of you agreed — duo locked and finalized!" : "✓ Recorded — waiting for your roommate to lock too");
          closeModal();
          await refreshState();
        } catch (err) { toast("❌ " + err.message); }
      };
    },
  });
}

function renderFAQ() {
  document.getElementById("faq-list").innerHTML = FAQS.map((f, i) => `
    <div class="faq-item ${i === 0 ? "open" : ""}" data-faq="${i}">
      <div class="faq-q"><span>${escapeHTML(f.q)}</span><span>▾</span></div>
      <div class="faq-a">${escapeHTML(f.a)}</div>
    </div>`).join("");
}

/* ------------------------------ modals ------------------------------ */

function showLoginModal() {
  openModal(`
    <div class="modal-head"><h3>Log in</h3><button class="modal-close" data-close>✕</button></div>
    <form id="login-form">
      <div class="field"><label>Roll Number</label><input id="login-roll" class="mono" placeholder="25AI1034" required /></div>
      <div class="field"><label>Password</label><input id="login-pass" type="password" placeholder="Your roll number, by default" required /></div>
      <p class="hint">New here? Your temporary password is your roll number.</p>
      <button type="submit" class="grad-btn" style="width:100%;margin-top:0.5rem;">Log in</button>
    </form>
  `, {
    onMount: (box) => {
      box.querySelector("[data-close]").onclick = closeModal;
      box.querySelector("#login-form").onsubmit = async (e) => {
        e.preventDefault();
        const roll = box.querySelector("#login-roll").value.trim();
        const pass = box.querySelector("#login-pass").value.trim();
        try {
          const data = await api("/api/login", { method: "POST", body: JSON.stringify({ roll, password: pass }) });
          state.session = { rollNumber: data.student.rollNumber };
          localStorage.setItem("gsv_session", JSON.stringify(state.session));
          toast(`✅ Welcome back, ${data.student.name.split(" ")[0]}`);
          closeModal();
          await refreshState();
          enterPortal(); // auto-routes to GSV or Stanza based on data.student.hostelType
        } catch (err) {
          toast("❌ " + err.message);
        }
      };
    },
  });
}

function showProfileModal(roll) {
  const s = studentByRoll(roll);
  if (!s) return;
  const me = currentStudent();
  const isOwn = me && me.rollNumber === s.rollNumber;
  const group = s.groupId ? state.groups.find((g) => g.id === s.groupId) : null;
  const groupMembers = group ? group.memberIds.filter((r) => r !== s.rollNumber).map(studentByRoll).filter(Boolean) : [];
  const isLocked = !!(group && group.locked);
  const hostelLabel = s.hostelType === "GSV" ? "GSV Campus Hostel" : "Stanza Living Hostel";

  let leaveSectionHTML = "";
  if (isOwn && s.status !== "looking") {
    if (isLocked && s.hostelType === "STANZA") {
      leaveSectionHTML = `<div class="hint" style="margin-top:0.6rem">This room partnership has been finalized and can no longer be changed.</div>`;
    } else if (isLocked) {
      leaveSectionHTML = `<div class="hint" style="margin-top:0.6rem">🔒 Your trio is locked. All three of you must agree to unlock it before anyone can leave.</div>`;
    } else {
      leaveSectionHTML = `<button class="link-btn" style="width:100%;margin-top:0.4rem;color:var(--danger)" id="btn-leave">Leave ${s.status === "trio" ? "Trio" : "Duo"}</button>`;
    }
  }

  openModal(`
    <div class="modal-head"><h3>Profile</h3><button class="modal-close" data-close>✕</button></div>
    <div class="student-row">
      ${avatarHTML(s.name, "lg")}
      <div><div class="student-name" style="font-size:1.05rem">${escapeHTML(s.name)}</div><div class="student-roll mono">${s.rollNumber} · ${s.branch}</div></div>
    </div>
    <div style="margin-top:0.9rem;display:flex;gap:0.4rem;flex-wrap:wrap">
      <span class="status-badge ${STATUS_META[s.status].cls}">${STATUS_META[s.status].dot} ${STATUS_META[s.status].label}</span>
      ${isLocked ? ` <span class="status-badge">🔒 Locked</span>` : ""}
      <span class="status-badge">🏨 ${hostelLabel}${s.rank ? ` · Rank ${s.rank}` : ""}</span>
    </div>
    ${groupMembers.length ? `
      <div style="margin-top:1rem">
        <div class="hint" style="margin-bottom:0.5rem">${s.status === "trio" ? "Roommates" : "Roommate"}</div>
        ${groupMembers.map((m) => `
          <div class="mini-profile" style="margin:0 0 0.5rem;padding:0.6rem">
            ${avatarHTML(m.name, "sm")}
            <div><div class="student-name">${escapeHTML(m.name)}</div><div class="student-roll mono">${m.rollNumber}</div></div>
          </div>`).join("")}
      </div>` : ""}
    <div class="modal-actions">
      <button class="outline-btn" id="btn-copy-link">🔗 Copy Link</button>
      ${isOwn ? `<button class="grad-btn" id="btn-edit-profile">✏️ Edit</button>` : `<button class="grad-btn" id="btn-login-as">Log in as you?</button>`}
    </div>
    ${isOwn ? `<button class="link-btn" style="width:100%;margin-top:0.6rem;" id="btn-change-password">🔒 Change Password</button>` : ""}
    ${leaveSectionHTML}
    ${isOwn && s.hostelType === "GSV" ? `<button class="link-btn" style="width:100%;margin-top:0.4rem;color:var(--danger)" id="btn-opt-out" data-opt-out>Opt Out of GSV Hostel</button>` : ""}
  `, {
    onMount: (box) => {
      box.querySelector("[data-close]").onclick = closeModal;
      box.querySelector("#btn-copy-link").onclick = () => {
        const text = `${s.name} (${s.rollNumber}) — ${STATUS_META[s.status].label} — GSV Hostel RoomMatch`;
        navigator.clipboard?.writeText(text).catch(() => {});
        toast("🔗 Profile copied to clipboard");
      };
      if (isOwn) {
        box.querySelector("#btn-edit-profile").onclick = () => showProfileEditModal(s);
        box.querySelector("#btn-change-password").onclick = () => showChangePasswordModal(s);
        const leaveBtn = box.querySelector("#btn-leave");
        if (leaveBtn) leaveBtn.onclick = () => showConfirmLeaveModal(s);
        // #btn-opt-out is handled by the delegated [data-opt-out] click handler
      } else {
        box.querySelector("#btn-login-as").onclick = () => { closeModal(); showLoginModal(); };
      }
    },
  });
}

function showChangePasswordModal(s) {
  openModal(`
    <div class="modal-head"><h3>Change password</h3><button class="modal-close" data-close>✕</button></div>
    <form id="pass-form">
      <div class="field"><label>Current Password</label><input id="cp-current" type="password" required /></div>
      <div class="field"><label>New Password</label><input id="cp-new" type="password" minlength="4" required /></div>
      <div class="field"><label>Confirm New Password</label><input id="cp-confirm" type="password" minlength="4" required /></div>
      <p class="hint">Use at least 4 characters. Once you set your own password, your roll number will no longer work as a login password.</p>
      <button type="submit" class="grad-btn" style="width:100%;margin-top:0.5rem;">Update password</button>
    </form>
  `, {
    onMount: (box) => {
      box.querySelector("[data-close]").onclick = closeModal;
      box.querySelector("#pass-form").onsubmit = async (e) => {
        e.preventDefault();
        const current = box.querySelector("#cp-current").value;
        const next = box.querySelector("#cp-new").value;
        const confirmPass = box.querySelector("#cp-confirm").value;
        if (next !== confirmPass) { toast("❌ New passwords don't match"); return; }
        try {
          await api("/api/change-password", { method: "POST", body: JSON.stringify({ rollNumber: s.rollNumber, currentPassword: current, newPassword: next }) });
          toast("✅ Password updated");
          closeModal();
        } catch (err) { toast("❌ " + err.message); }
      };
    },
  });
}

function showProfileEditModal(s) {
  const branches = [...new Set(state.students.map((x) => x.branch))].sort();
  openModal(`
    <div class="modal-head"><h3>Edit profile</h3><button class="modal-close" data-close>✕</button></div>
    <form id="edit-form">
      <div class="field"><label>Name</label><input id="edit-name" value="${escapeHTML(s.name)}" required /></div>
      <div class="field"><label>Branch</label>
        <select id="edit-branch">${branches.map((b) => `<option value="${b}" ${b === s.branch ? "selected" : ""}>${b}</option>`).join("")}</select>
      </div>
      <div class="hint" style="background:var(--surface-solid);border:1px solid var(--border);border-radius:0.75rem;padding:0.6rem 0.9rem;" class="mono">Roll Number: ${s.rollNumber} (fixed)</div>
      <button type="submit" class="grad-btn" style="width:100%;margin-top:0.75rem;">Save changes</button>
    </form>
  `, {
    onMount: (box) => {
      box.querySelector("[data-close]").onclick = closeModal;
      box.querySelector("#edit-form").onsubmit = async (e) => {
        e.preventDefault();
        const name = box.querySelector("#edit-name").value.trim() || s.name;
        const branch = box.querySelector("#edit-branch").value;
        try {
          await api("/api/profile", { method: "POST", body: JSON.stringify({ rollNumber: s.rollNumber, name, branch }) });
          toast("✅ Profile updated");
          closeModal();
          await refreshState();
        } catch (err) { toast("❌ " + err.message); }
      };
    },
  });
}

function showOptOutConfirmModal() {
  openModal(`
    <h3>Exit GSV Hostel?</h3>
    <p class="hint" style="margin:0.5rem 0 1.25rem">You are about to permanently give up your GSV Campus Hostel seat. You will immediately be transferred to Stanza Living Hostel. Your decision cannot be undone automatically. Do you wish to continue?</p>
    <div class="modal-actions">
      <button class="outline-btn" id="btn-cancel">Cancel</button>
      <button class="grad-btn" id="btn-confirm" style="background:var(--danger)">Yes, Exit GSV</button>
    </div>
  `, {
    onMount: (box) => {
      box.querySelector("#btn-cancel").onclick = closeModal;
      box.querySelector("#btn-confirm").onclick = async () => {
        const me = currentStudent();
        try {
          await api("/api/opt-out", { method: "POST", body: JSON.stringify({ rollNumber: me.rollNumber }) });
          toast("You've exited GSV Campus Hostel and moved to Stanza Living.");
          closeModal();
          await refreshState();
          enterPortal(); // now routes to the Stanza portal automatically
        } catch (err) { toast("❌ " + err.message); }
      };
    },
  });
}

function showConfirmLeaveModal(s) {
  openModal(`
    <h3>Leave ${s.status === "trio" ? "Trio" : "Duo"}?</h3>
    <p class="hint" style="margin:0.5rem 0 1.25rem">Your roommates will be notified by your status changing back to Looking. This can't be undone.</p>
    <div class="modal-actions">
      <button class="outline-btn" id="btn-cancel">Cancel</button>
      <button class="grad-btn" id="btn-confirm" style="background:var(--danger)">Leave</button>
    </div>
  `, {
    onMount: (box) => {
      box.querySelector("#btn-cancel").onclick = closeModal;
      box.querySelector("#btn-confirm").onclick = async () => {
        try {
          await api("/api/leave", { method: "POST", body: JSON.stringify({ rollNumber: s.rollNumber }) });
          toast(`You left the ${s.status === "trio" ? "trio" : "duo"}`);
          closeModal();
          await refreshState();
        } catch (err) { toast("❌ " + err.message); }
      };
    },
  });
}

function showLockConfirmModal(groupId) {
  openModal(`
    <h3>Lock this trio?</h3>
    <p class="hint" style="margin:0.5rem 0 1.25rem">This finalizes your room lineup. After locking, all three of you will need to agree before anyone can unlock it or leave.</p>
    <div class="modal-actions">
      <button class="outline-btn" id="btn-cancel">Cancel</button>
      <button class="grad-btn" id="btn-confirm">🔒 Lock Trio</button>
    </div>
  `, {
    onMount: (box) => {
      box.querySelector("#btn-cancel").onclick = closeModal;
      box.querySelector("#btn-confirm").onclick = async () => {
        const me = currentStudent();
        try {
          await api(`/api/groups/${groupId}/lock`, { method: "POST", body: JSON.stringify({ actingRoll: me.rollNumber }) });
          toast("🔒 Trio locked");
          closeModal();
          await refreshState();
        } catch (err) { toast("❌ " + err.message); }
      };
    },
  });
}

function showRequestUnlockConfirmModal(groupId) {
  openModal(`
    <h3>Request to unlock?</h3>
    <p class="hint" style="margin:0.5rem 0 1.25rem">Your other two roommates will each need to agree before the trio actually unlocks.</p>
    <div class="modal-actions">
      <button class="outline-btn" id="btn-cancel">Cancel</button>
      <button class="grad-btn" id="btn-confirm">Request Unlock</button>
    </div>
  `, {
    onMount: (box) => {
      box.querySelector("#btn-cancel").onclick = closeModal;
      box.querySelector("#btn-confirm").onclick = async () => {
        const me = currentStudent();
        try {
          await api(`/api/groups/${groupId}/request-unlock`, { method: "POST", body: JSON.stringify({ actingRoll: me.rollNumber }) });
          toast("Unlock request sent to your roommates");
          closeModal();
          await refreshState();
        } catch (err) { toast("❌ " + err.message); }
      };
    },
  });
}

function showInviteModal(toRoll) {
  const me = currentStudent();
  const target = studentByRoll(toRoll);
  if (!me) { showLoginModal(); return; }
  if (!target) return;
  const isTrioProposal = me.status === "duo";
  openModal(`
    <div class="modal-head"><h3>${isTrioProposal ? "Invite a third roommate" : "Invite to duo"}</h3><button class="modal-close" data-close>✕</button></div>
    <div class="mini-profile">
      ${avatarHTML(target.name, "sm")}
      <div><div class="student-name">${escapeHTML(target.name)}</div><div class="student-roll mono">${target.rollNumber} · ${target.branch}</div></div>
    </div>
    ${isTrioProposal ? `<p class="hint" style="margin:0.7rem 0">Since you're in a duo, this first goes to your roommate for approval. ${escapeHTML(target.name.split(" ")[0])} will only see the invite once your roommate approves.</p>` : ""}
    <form id="invite-form">
      <div class="field"><label>Message (optional)</label><textarea id="invite-message" rows="3" placeholder="Introduce yourself…"></textarea></div>
      <button type="submit" class="grad-btn" style="width:100%;">${isTrioProposal ? "Propose Invite" : `Send invite as ${escapeHTML(me.name)}`}</button>
    </form>
  `, {
    onMount: (box) => {
      box.querySelector("[data-close]").onclick = closeModal;
      box.querySelector("#invite-form").onsubmit = async (e) => {
        e.preventDefault();
        const message = box.querySelector("#invite-message").value.trim();
        try {
          if (isTrioProposal) {
            await api("/api/trio-invite", { method: "POST", body: JSON.stringify({ fromRoll: me.rollNumber, toRoll: target.rollNumber, message }) });
            toast("✅ Proposal sent to your roommate for approval");
          } else {
            await api("/api/invite", { method: "POST", body: JSON.stringify({ fromRoll: me.rollNumber, toRoll: target.rollNumber, message }) });
            toast("✅ Invite Sent");
          }
          closeModal();
          await refreshState();
        } catch (err) {
          toast("❌ " + err.message);
        }
      };
    },
  });
}

function showJoinRequestModal(groupId) {
  const me = currentStudent();
  openModal(`
    <div class="modal-head"><h3>Request to join</h3><button class="modal-close" data-close>✕</button></div>
    <p class="hint" style="margin-bottom:1rem">Send a request to this duo. They'll see it once they log in.</p>
    <form id="join-form">
      <div class="field"><label>Your Name</label><input id="join-name" value="${me ? escapeHTML(me.name) : ""}" required /></div>
      <div class="field"><label>Your Roll Number</label><input id="join-roll" class="mono" value="${me ? me.rollNumber : ""}" required /></div>
      <div class="field"><label>Message (optional)</label><textarea id="join-message" rows="3" placeholder="Say hi, mention shared interests…"></textarea></div>
      <button type="submit" class="grad-btn" style="width:100%;">Send request</button>
    </form>
  `, {
    onMount: (box) => {
      box.querySelector("[data-close]").onclick = closeModal;
      box.querySelector("#join-form").onsubmit = async (e) => {
        e.preventDefault();
        const name = box.querySelector("#join-name").value.trim();
        const rollNumber = box.querySelector("#join-roll").value.trim();
        const message = box.querySelector("#join-message").value.trim();
        try {
          await api("/api/join-request", { method: "POST", body: JSON.stringify({ targetGroupId: groupId, rollNumber, name, message }) });
          toast("✅ Request Sent");
          closeModal();
          await refreshState();
        } catch (err) { toast("❌ " + err.message); }
      };
    },
  });
}

function requestItemHTML(r) {
  const me = currentStudent();

  if (r.type === "join_duo") {
    const myDecision = r.approvals ? r.approvals[me.rollNumber] : null;
    if (myDecision === "accepted") {
      return `
        <div class="req-item" data-req="${r.id}">
          <div class="student-name">${escapeHTML(r.fromName)} wants to join your duo</div>
          <div class="student-roll mono">${r.fromRoll} · ${timeAgo(r.timestamp)}</div>
          <div class="hint" style="margin-top:0.4rem">✓ You accepted — waiting for your roommate to respond to complete the trio.</div>
        </div>`;
    }
    return `
      <div class="req-item" data-req="${r.id}">
        <div class="student-name">${escapeHTML(r.fromName)} wants to join your duo</div>
        <div class="student-roll mono">${r.fromRoll} · ${timeAgo(r.timestamp)}</div>
        ${r.message ? `<div class="hint" style="margin-top:0.4rem;font-style:italic">"${escapeHTML(r.message)}"</div>` : ""}
        <div class="req-actions">
          <button class="outline-btn" data-reject="${r.id}">✕ Reject</button>
          <button class="grad-btn" data-accept="${r.id}">✓ Accept</button>
        </div>
      </div>`;
  }

  if (r.type === "trio_invite") {
    if (r.status === "pending_partner") {
      const myDecision = r.approvals ? r.approvals[me.rollNumber] : null;
      if (myDecision === "accepted") {
        return `
          <div class="req-item" data-req="${r.id}">
            <div class="student-name">Proposal to invite ${escapeHTML(r.toName)}</div>
            <div class="student-roll mono">${timeAgo(r.timestamp)}</div>
            <div class="hint" style="margin-top:0.4rem">✓ You approved — waiting for the invite to reach ${escapeHTML(r.toName)}.</div>
          </div>`;
      }
      return `
        <div class="req-item" data-req="${r.id}">
          <div class="student-name">${escapeHTML(r.fromName)} wants to invite ${escapeHTML(r.toName)} to your trio</div>
          <div class="student-roll mono">${timeAgo(r.timestamp)}</div>
          ${r.message ? `<div class="hint" style="margin-top:0.4rem;font-style:italic">"${escapeHTML(r.message)}"</div>` : ""}
          <div class="req-actions">
            <button class="outline-btn" data-reject="${r.id}">✕ Reject</button>
            <button class="grad-btn" data-accept="${r.id}">✓ Approve</button>
          </div>
        </div>`;
    }
    // status === "pending_target" — the invited student sees this
    return `
      <div class="req-item" data-req="${r.id}">
        <div class="student-name">${escapeHTML(r.fromName)}'s duo invited you to join their trio</div>
        <div class="student-roll mono">${timeAgo(r.timestamp)}</div>
        ${r.message ? `<div class="hint" style="margin-top:0.4rem;font-style:italic">"${escapeHTML(r.message)}"</div>` : ""}
        <div class="req-actions">
          <button class="outline-btn" data-reject="${r.id}">✕ Reject</button>
          <button class="grad-btn" data-accept="${r.id}">✓ Accept</button>
        </div>
      </div>`;
  }

  if (r.type === "unlock_trio") {
    const myDecision = r.approvals ? r.approvals[me.rollNumber] : null;
    const approvedCount = r.approvals ? Object.values(r.approvals).filter((d) => d === "accepted").length : 0;
    if (myDecision === "accepted") {
      return `
        <div class="req-item" data-req="${r.id}">
          <div class="student-name">Request to unlock your trio</div>
          <div class="student-roll mono">${timeAgo(r.timestamp)}</div>
          <div class="hint" style="margin-top:0.4rem">✓ You agreed — ${approvedCount}/3 approved so far.</div>
        </div>`;
    }
    return `
      <div class="req-item" data-req="${r.id}">
        <div class="student-name">${escapeHTML(r.fromName)} wants to unlock your trio</div>
        <div class="student-roll mono">${timeAgo(r.timestamp)} · ${approvedCount}/3 approved</div>
        <div class="req-actions">
          <button class="outline-btn" data-reject="${r.id}">✕ Reject</button>
          <button class="grad-btn" data-accept="${r.id}">✓ Agree to unlock</button>
        </div>
      </div>`;
  }

  // duo_invite
  return `
    <div class="req-item" data-req="${r.id}">
      <div class="student-name">${escapeHTML(r.fromName)} invited you to be roommates</div>
      <div class="student-roll mono">${r.fromRoll} · ${timeAgo(r.timestamp)}</div>
      ${r.message ? `<div class="hint" style="margin-top:0.4rem;font-style:italic">"${escapeHTML(r.message)}"</div>` : ""}
      <div class="req-actions">
        <button class="outline-btn" data-reject="${r.id}">✕ Reject</button>
        <button class="grad-btn" data-accept="${r.id}">✓ Accept</button>
      </div>
    </div>`;
}

function showRequestsInbox() {
  const items = pendingRequestsForMe();
  const notifs = state.notifications;
  openModal(`
    <div class="modal-head"><h3>Your requests</h3><button class="modal-close" data-close>✕</button></div>
    <div id="req-list">
      ${items.length === 0
        ? `<div class="empty-state">Nothing pending. New invites and join requests will show up here.</div>`
        : items.map(requestItemHTML).join("")}
    </div>
    <div class="modal-head" style="margin-top:1.5rem"><h3>Notifications</h3></div>
    <div id="notif-list">
      ${notifs.length === 0
        ? `<div class="empty-state">No notifications yet.</div>`
        : notifs.map((n) => `
          <div class="req-item">
            <div class="student-name" style="font-weight:500">${n.isRead ? "" : "🔵 "}${escapeHTML(n.message)}</div>
            <div class="student-roll mono">${timeAgo(n.timestamp)}</div>
          </div>`).join("")}
    </div>
  `, { wide: true, onMount: (box) => {
      box.querySelector("[data-close]").onclick = closeModal;
      box.querySelectorAll("[data-accept]").forEach((btn) => btn.onclick = async () => {
        const me = currentStudent();
        try {
          const res = await api(`/api/requests/${btn.dataset.accept}/accept`, { method: "POST", body: JSON.stringify({ actingRoll: me.rollNumber }) });
          if (res.unlocked) toast("🔓 Everyone agreed — trio unlocked!");
          else if (res.cancelled) toast("That invite is no longer available");
          else if (res.sentToTarget) toast("✅ Approved — invite sent to the student");
          else if (res.waiting) toast("✅ Recorded — waiting on the others");
          else toast("🎉 Done!");
          closeModal();
          await refreshState();
        } catch (err) { toast("❌ " + err.message); }
      });
      box.querySelectorAll("[data-reject]").forEach((btn) => btn.onclick = async () => {
        const me = currentStudent();
        try {
          await api(`/api/requests/${btn.dataset.reject}/reject`, { method: "POST", body: JSON.stringify({ actingRoll: me.rollNumber }) });
          toast("Request rejected");
          closeModal();
          await refreshState();
        } catch (err) { toast("❌ " + err.message); }
      });
    } });
  markNotificationsRead();
}

/* ------------------------------ admin view ------------------------------ */

function showAdminLoginGate() {
  const container = document.getElementById("main-admin");
  container.innerHTML = `
    <div class="hero" style="max-width:420px">
      <h2 style="margin-bottom:1rem">Admin Access</h2>
      <form id="admin-login-form">
        <div class="field"><label>Admin Password</label><input id="admin-pass" type="password" required /></div>
        <button type="submit" class="grad-btn" style="width:100%">Enter</button>
      </form>
      <p class="hint" style="margin-top:0.75rem">${ADMIN_PASSWORD_HINT}</p>
      <button class="link-btn" style="margin-top:1rem" id="admin-back">← Back to site</button>
    </div>`;
  container.querySelector("#admin-back").onclick = goHome;
  container.querySelector("#admin-login-form").onsubmit = async (e) => {
    e.preventDefault();
    const pass = container.querySelector("#admin-pass").value;
    try {
      await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password: pass }) });
      state.adminAuthed = true;
      sessionStorage.setItem("gsv_admin_authed", "1");
      await refreshAdminState();
      renderAdmin();
    } catch (err) { toast("❌ " + err.message); }
  };
}

let adminTab = "students";

function renderAdmin() {
  const container = document.getElementById("main-admin");
  if (!state.adminAuthed) { showAdminLoginGate(); return; }
  if (!state.adminData) {
    container.innerHTML = `<div class="hero"><p class="muted">Loading admin dashboard…</p></div>`;
    refreshAdminState().then(renderAdmin).catch((err) => toast("❌ " + err.message));
    return;
  }

  const cap = state.capacity;
  const cards = [
    { label: "Total Students", value: cap.totalStudents, icon: "👥" },
    { label: "Total GSV", value: cap.gsvOccupied, icon: "🏨" },
    { label: "Total Stanza", value: cap.stanzaTotal, icon: "🏢" },
    { label: "Available GSV Seats", value: cap.gsvAvailable, icon: "🟢" },
    { label: "Students Waiting", value: cap.waitingList.length, icon: "⏳" },
    { label: "GSV Trios", value: cap.gsvTrios, icon: "✅" },
    { label: "Stanza Duos", value: cap.stanzaDuos, icon: "🤝" },
    { label: "Pending Requests", value: cap.pendingRequests, icon: "📨" },
  ];

  container.innerHTML = `
    <div class="admin-header">
      <h2>Admin Dashboard</h2>
      <button class="outline-btn small" id="admin-back">← Back to site</button>
    </div>
    <div class="stats-grid" style="margin-bottom:1.25rem">
      ${cards.map((c) => `
        <div class="card stat-card">
          <div class="stat-icon">${c.icon}</div>
          <div class="stat-value">${c.value}</div>
          <div class="stat-label">${c.label}</div>
        </div>`).join("")}
    </div>
    <div class="admin-tabs">
      <button class="admin-tab ${adminTab === "students" ? "active" : ""}" data-tab="students">Students (${state.adminData.students.length})</button>
      <button class="admin-tab ${adminTab === "groups" ? "active" : ""}" data-tab="groups">Groups (${state.adminData.groups.length})</button>
      <button class="admin-tab ${adminTab === "requests" ? "active" : ""}" data-tab="requests">Requests (${state.adminData.requests.length})</button>
      <button class="admin-tab ${adminTab === "waiting" ? "active" : ""}" data-tab="waiting">Waiting List (${cap.waitingList.length})</button>
    </div>
    <div class="admin-panel" id="admin-panel-body"></div>
  `;
  container.querySelector("#admin-back").onclick = goHome;
  container.querySelectorAll(".admin-tab").forEach((btn) => btn.onclick = () => { adminTab = btn.dataset.tab; renderAdmin(); });

  const body = document.getElementById("admin-panel-body");
  if (adminTab === "students") renderAdminStudents(body);
  else if (adminTab === "groups") renderAdminGroups(body);
  else if (adminTab === "waiting") renderAdminWaitingList(body);
  else renderAdminRequests(body);
}

function renderAdminWaitingList(body) {
  const waiting = state.capacity.waitingList;
  if (waiting.length === 0) {
    body.innerHTML = `<div class="empty-state">No one is waiting — GSV is either full with no queue, or every seat is filled.</div>`;
    return;
  }
  body.innerHTML = `
    <table class="admin-table">
      <thead><tr><th>Queue #</th><th>Rank</th><th>Name</th><th>Roll</th><th>Branch</th></tr></thead>
      <tbody>
        ${waiting.map((w, i) => `
          <tr>
            <td>${i + 1}</td>
            <td class="mono">${w.rank}</td>
            <td>${escapeHTML(w.name)}</td>
            <td class="mono">${w.rollNumber}</td>
            <td>${w.branch}</td>
          </tr>`).join("")}
      </tbody>
    </table>
    <p class="hint" style="margin-top:0.75rem">Whenever a GSV seat opens (opt-out, removal, etc.), rank #1 on this list is promoted automatically.</p>
  `;
}

function renderAdminStudents(body) {
  body.innerHTML = `
    <div class="admin-toolbar">
      <button class="grad-btn small" id="btn-add-student">+ Add Student</button>
      <a class="outline-btn small" href="${API_BASE}/api/admin/export.csv" style="text-decoration:none">⬇ Export CSV</a>
    </div>
    <table class="admin-table">
      <thead><tr><th>Name</th><th>Roll</th><th>Branch</th><th>CGPA</th><th>Rank</th><th>Hostel</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${state.adminData.students.map((s) => `
          <tr>
            <td>${escapeHTML(s.name)}</td>
            <td class="mono">${s.rollNumber}</td>
            <td>${s.branch}</td>
            <td>${s.cgpa ?? "-"}</td>
            <td class="mono">${s.rank ?? "-"}</td>
            <td>${s.hostelType === "GSV" ? "🏨 GSV" : "🏢 Stanza"}${s.optedOutOfGsv ? " (opted out)" : ""}</td>
            <td>${STATUS_META[s.status].label}</td>
            <td class="admin-actions-cell">
              <button class="tiny-btn" data-edit="${s.rollNumber}">Edit</button>
              <button class="tiny-btn danger" data-remove="${s.rollNumber}">Remove</button>
            </td>
          </tr>`).join("")}
      </tbody>
    </table>
  `;
  body.querySelector("#btn-add-student").onclick = () => adminAddStudentModal();
  body.querySelectorAll("[data-edit]").forEach((btn) => btn.onclick = () => adminEditStudentModal(state.adminData.students.find((s) => s.rollNumber === btn.dataset.edit)));
  body.querySelectorAll("[data-remove]").forEach((btn) => btn.onclick = async () => {
    if (!confirm("Remove this student?")) return;
    try {
      await api(`/api/admin/students/${btn.dataset.remove}`, { method: "DELETE" });
      toast("Student removed");
      await refreshAdminState();
      renderAdmin();
    } catch (err) { toast("❌ " + err.message); }
  });
}

function adminAddStudentModal() {
  openModal(`
    <div class="modal-head"><h3>Add student</h3><button class="modal-close" data-close>✕</button></div>
    <form id="add-form">
      <div class="field"><label>Name</label><input id="add-name" required /></div>
      <div class="field"><label>Roll Number</label><input id="add-roll" class="mono" required /></div>
      <div class="field"><label>Branch</label><input id="add-branch" required /></div>
      <div class="field"><label>Rank (optional — defaults to the back of the Stanza queue)</label><input id="add-rank" type="number" min="1" /></div>
      <div class="field"><label>Hostel</label>
        <select id="add-hostel">
          <option value="STANZA" selected>Stanza Living</option>
          <option value="GSV">GSV Campus Hostel</option>
        </select>
      </div>
      <button type="submit" class="grad-btn" style="width:100%">Add</button>
    </form>
  `, { onMount: (box) => {
    box.querySelector("[data-close]").onclick = closeModal;
    box.querySelector("#add-form").onsubmit = async (e) => {
      e.preventDefault();
      const name = box.querySelector("#add-name").value.trim();
      const rollNumber = box.querySelector("#add-roll").value.trim();
      const branch = box.querySelector("#add-branch").value.trim();
      const rankVal = box.querySelector("#add-rank").value;
      const hostelType = box.querySelector("#add-hostel").value;
      try {
        await api("/api/admin/students", { method: "POST", body: JSON.stringify({
          name, rollNumber, branch, hostelType, rank: rankVal ? Number(rankVal) : undefined,
        }) });
        toast("✅ Student added");
        closeModal();
        await refreshAdminState();
        renderAdmin();
      } catch (err) { toast("❌ " + err.message); }
    };
  }});
}

function adminEditStudentModal(s) {
  if (!s) return;
  openModal(`
    <div class="modal-head"><h3>Edit student</h3><button class="modal-close" data-close>✕</button></div>
    <form id="edit-admin-form">
      <div class="field"><label>Name</label><input id="ea-name" value="${escapeHTML(s.name)}" required /></div>
      <div class="field"><label>Branch</label><input id="ea-branch" value="${escapeHTML(s.branch)}" required /></div>
      <div class="field"><label>Rank</label><input id="ea-rank" type="number" min="1" value="${s.rank ?? ""}" /></div>
      <div class="field"><label>Hostel</label>
        <select id="ea-hostel">
          <option value="GSV" ${s.hostelType === "GSV" ? "selected" : ""}>GSV Campus Hostel</option>
          <option value="STANZA" ${s.hostelType === "STANZA" ? "selected" : ""}>Stanza Living</option>
        </select>
      </div>
      <p class="hint">Changing hostel here re-runs the waiting-list promotion logic and clears their current group.</p>
      <button type="submit" class="grad-btn" style="width:100%">Save</button>
    </form>
  `, { onMount: (box) => {
    box.querySelector("[data-close]").onclick = closeModal;
    box.querySelector("#edit-admin-form").onsubmit = async (e) => {
      e.preventDefault();
      const name = box.querySelector("#ea-name").value.trim();
      const branch = box.querySelector("#ea-branch").value.trim();
      const rank = box.querySelector("#ea-rank").value;
      const hostelType = box.querySelector("#ea-hostel").value;
      try {
        await api(`/api/admin/students/${s.rollNumber}`, { method: "PUT", body: JSON.stringify({
          name, branch, rank: rank ? Number(rank) : undefined, hostelType,
        }) });
        toast("✅ Student updated");
        closeModal();
        await refreshAdminState();
        renderAdmin();
      } catch (err) { toast("❌ " + err.message); }
    };
  }});
}

function renderAdminGroups(body) {
  if (state.adminData.groups.length === 0) {
    body.innerHTML = `<div class="empty-state">No groups yet.</div>`;
    return;
  }
  body.innerHTML = state.adminData.groups.map((g) => {
    const members = g.memberIds.map((r) => state.adminData.students.find((s) => s.rollNumber === r)).filter(Boolean).map((m) => m.name).join(", ");
    return `
      <div class="card" style="padding:0.9rem;margin-bottom:0.6rem;display:flex;justify-content:space-between;align-items:center;gap:1rem;">
        <div><strong>${g.hostelType} ${g.type.toUpperCase()}</strong>${g.locked ? " 🔒" : ""} — ${escapeHTML(members)}</div>
        <button class="tiny-btn danger" data-dissolve="${g.id}">Dissolve</button>
      </div>`;
  }).join("");
  body.querySelectorAll("[data-dissolve]").forEach((btn) => btn.onclick = async () => {
    if (!confirm("Dissolve this group?")) return;
    try {
      await api(`/api/admin/groups/${btn.dataset.dissolve}/dissolve`, { method: "POST" });
      toast("Group dissolved");
      await refreshAdminState();
      renderAdmin();
    } catch (err) { toast("❌ " + err.message); }
  });
}

function renderAdminRequests(body) {
  if (state.adminData.requests.length === 0) {
    body.innerHTML = `<div class="empty-state">No requests yet.</div>`;
    return;
  }
  body.innerHTML = state.adminData.requests.map((r) => `
    <div class="card" style="padding:0.9rem;margin-bottom:0.6rem;display:flex;justify-content:space-between;align-items:center;gap:1rem;">
      <div>
        <strong>${r.type}</strong> — ${escapeHTML(r.fromName)} → ${r.toRoll || r.targetGroupId} · ${r.status} · ${timeAgo(r.timestamp)}
      </div>
      <button class="tiny-btn danger" data-del-req="${r.id}">Delete</button>
    </div>`).join("");
  body.querySelectorAll("[data-del-req]").forEach((btn) => btn.onclick = async () => {
    try {
      await api(`/api/admin/requests/${btn.dataset.delReq}`, { method: "DELETE" });
      await refreshAdminState();
      renderAdmin();
    } catch (err) { toast("❌ " + err.message); }
  });
}

/* ------------------------------ navigation ------------------------------ */

const ALL_MAINS = ["login-gate", "main-home", "main-stanza", "main-admin"];

function hideAllMains() {
  ALL_MAINS.forEach((id) => document.getElementById(id).classList.add("hidden"));
}

function showGate() {
  state.view = "gate";
  hideAllMains();
  document.getElementById("login-gate").classList.remove("hidden");
  renderNavbar();
}

function enterPortal() {
  // Route automatically based on the logged-in student's hostel — the
  // student never manually picks GSV vs Stanza.
  const me = currentStudent();
  hideAllMains();
  if (me && me.hostelType === "STANZA") {
    state.view = "stanza";
    document.getElementById("main-stanza").classList.remove("hidden");
  } else {
    state.view = "home";
    document.getElementById("main-home").classList.remove("hidden");
  }
  renderAll();
}

function goHome() {
  if (!state.session) { showGate(); return; }
  enterPortal();
}
function goAdmin() {
  state.view = "admin";
  hideAllMains();
  document.getElementById("main-admin").classList.remove("hidden");
  if (state.adminAuthed) {
    refreshAdminState().then(renderAdmin).catch((err) => { toast("❌ " + err.message); renderAdmin(); });
  } else {
    renderAdmin();
  }
  renderNavbar();
}
function scrollToId(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ------------------------------ event wiring ------------------------------ */

function wireEvents() {
  document.getElementById("btn-home").onclick = goHome;
  document.getElementById("btn-admin").onclick = goAdmin;
  document.getElementById("btn-login").onclick = showLoginModal;
  document.getElementById("btn-gate-login").onclick = showLoginModal;
  document.getElementById("btn-bell").onclick = showRequestsInbox;
  document.getElementById("btn-logout").onclick = () => {
    state.session = null;
    state.students = [];
    state.groups = [];
    state.requests = [];
    state.notifications = [];
    localStorage.removeItem("gsv_session");
    toast("Logged out");
    showGate();
  };
  document.getElementById("btn-theme").onclick = () => {
    state.theme = state.theme === "light" ? "dark" : "light";
    localStorage.setItem("gsv_theme", state.theme);
    applyTheme();
  };
  document.getElementById("btn-find-roommates").onclick = () => {
    if (!state.session) { showLoginModal(); toast("Log in first, then invite a looking student to be your roommate."); return; }
    const me = currentStudent();
    if (me && me.status === "trio") { toast("Your trio is already complete"); return; }
    state.filter = "looking";
    renderDirectory();
    scrollToId("directory");
    toast(me && me.status === "duo"
      ? 'Tap "Invite" on a student below — your roommate will need to approve before it\'s sent.'
      : 'Tap "Invite" on a student below to send a duo request.');
  };

  document.querySelectorAll("[data-scroll]").forEach((btn) => btn.onclick = () => scrollToId(btn.dataset.scroll));

  document.getElementById("search-input").oninput = (e) => { state.search = e.target.value; renderDirectory(); };
  document.getElementById("stanza-search-input").oninput = (e) => { state.stanzaSearch = e.target.value; renderStanzaLooking(); };
  document.getElementById("filter-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-filter]");
    if (!btn) return;
    state.filter = btn.dataset.filter;
    renderDirectory();
  });

  // Delegated clicks for dynamic content
  document.body.addEventListener("click", (e) => {
    console.log("Clicked:", e.target);
    const profileBtn = e.target.closest("[data-open-profile]");
    if (profileBtn) { showProfileModal(profileBtn.dataset.openProfile); return; }

    const avatarBtn = e.target.closest("#user-avatar");
    if (avatarBtn) { const me = currentStudent(); if (me) showProfileModal(me.rollNumber); return; }

    const inviteBtn = e.target.closest("[data-invite]");
    if (inviteBtn) { e.stopPropagation(); showInviteModal(inviteBtn.dataset.invite); return; }

    const joinBtn = e.target.closest("[data-join-group]");
    if (joinBtn) {
      if (!state.session) { showLoginModal(); return; }
      showJoinRequestModal(joinBtn.dataset.joinGroup);
      return;
    }

    const inviteThirdBtn = e.target.closest("[data-invite-third]");
    if (inviteThirdBtn) {
      if (!state.session) { showLoginModal(); return; }
      state.filter = "looking";
      renderDirectory();
      scrollToId("directory");
      toast('Tap "Invite" on a student below — your roommate will need to approve before it\'s sent.');
      return;
    }

    const lockBtn = e.target.closest("[data-lock-trio]");
    if (lockBtn) {
      if (!state.session) { showLoginModal(); return; }
      showLockConfirmModal(lockBtn.dataset.lockTrio);
      return;
    }

    const unlockBtn = e.target.closest("[data-request-unlock]");
    if (unlockBtn) {
      if (!state.session) { showLoginModal(); return; }
      showRequestUnlockConfirmModal(unlockBtn.dataset.requestUnlock);
      return;
    }

    const stanzaLockBtn = e.target.closest("[data-stanza-lock]");
    if (stanzaLockBtn) {
      if (!state.session) { showLoginModal(); return; }
      showStanzaLockConfirmModal(stanzaLockBtn.dataset.stanzaLock);
      return;
    }

    const optOutBtn = e.target.closest("[data-opt-out]");
    if (optOutBtn) {
      if (!state.session) { showLoginModal(); return; }
      showOptOutConfirmModal();
      return;
    }

    const faqItem = e.target.closest("[data-faq]");
    if (faqItem) { faqItem.classList.toggle("open"); return; }
  });
}

/* ------------------------------ boot ------------------------------ */

async function boot() {
  wireEvents();
  applyTheme();
  if (!state.session) {
    showGate();
    return;
  }
  try {
    await refreshState();
    enterPortal();
  } catch (err) {
    // Stale/invalid cached session — force a fresh login rather than
    // silently showing an error on a blank portal.
    state.session = null;
    localStorage.removeItem("gsv_session");
    toast("Please log in again");
    showGate();
  }
}

boot();
