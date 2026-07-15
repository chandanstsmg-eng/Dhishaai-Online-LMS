import { useState, useEffect, useRef, useCallback, createContext, useContext } from "react";
import { createPortal } from "react-dom";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// ─── API LAYER ────────────────────────────────────────────────────────────────
const API_BASE = "/api";
function getToken() { return localStorage.getItem("lms_token"); }
function setToken(t) { localStorage.setItem("lms_token", t); }
function clearToken() { localStorage.removeItem("lms_token"); }

async function api(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json", ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(API_BASE + path, opts);
  if (!res.ok) { const e = await res.json().catch(() => ({ error: "Network error" })); throw new Error(e.error || "Error"); }
  return res.json();
}
const GET = (p) => api("GET", p);
const POST = (p, b) => api("POST", p, b);
const PUT = (p, b) => api("PUT", p, b);
const DELETE = (p) => api("DELETE", p);

// Fetch a stored file ({ fileData, fileName, fileType }) from an API path and
// open it (PDF/image in a new tab) or download it. Returns true on success.
async function openStoredFile(path, fallbackName = "file") {
  const data = await GET(path);
  if (!data || !data.fileData) throw new Error("No file");
  const blob = await (await fetch(data.fileData)).blob();
  const url = URL.createObjectURL(blob);
  const name = data.fileName || fallbackName;
  const inline = /pdf|image/i.test(data.fileType || "") || /\.(pdf|png|jpe?g|gif|webp|svg)$/i.test(name);
  if (inline) {
    window.open(url, "_blank", "noopener");
  } else {
    const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

// ─── QUIZ ANTI-CHEAT GUARD ──────────────────────────────────────────────────────
// While a quiz is in progress, leaving the tab/window (switching tabs, minimizing,
// alt-tabbing) reports the student to their admin and forces them back to the
// login screen. Also applies best-effort screenshot deterrents.
// NOTE: browsers CANNOT truly block OS-level screenshots — these are deterrents only.
function useQuizGuard(active, ctx) {
  useEffect(() => {
    if (!active) return;
    let fired = false;
    const violate = (reason) => {
      if (fired) return; fired = true;
      try { POST("/quiz-violation", { quizId: ctx && ctx.quizId, courseId: ctx && ctx.courseId, reason }); } catch (e) {}
      try { sessionStorage.setItem("lms_lock_msg", "You were signed out because you left the quiz tab. This has been reported to your admin."); } catch (e) {}
      clearToken();
      window.dispatchEvent(new CustomEvent("lms-force-logout"));
    };
    const onVis = () => { if (document.hidden) violate("tab-switch"); };
    const onBlur = () => { setTimeout(() => { if (!fired && !document.hasFocus()) violate("left-window"); }, 200); };
    const onKey = (e) => { if (e.key === "PrintScreen") { try { navigator.clipboard && navigator.clipboard.writeText(""); } catch (e2) {} } };
    const onCtx = (e) => e.preventDefault();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("blur", onBlur);
    window.addEventListener("keyup", onKey);
    document.addEventListener("contextmenu", onCtx);
    document.body.classList.add("quiz-lock");
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keyup", onKey);
      document.removeEventListener("contextmenu", onCtx);
      document.body.classList.remove("quiz-lock");
    };
  }, [active, ctx && ctx.quizId, ctx && ctx.courseId]);
}

// ─── THEME CONTEXT ────────────────────────────────────────────────────────────
const ThemeCtx = createContext({ dark: false, toggle: () => {} });
function useTheme() { return useContext(ThemeCtx); }

// ─── BRAND COLORS ─────────────────────────────────────────────────────────────
const B = {
  orange: "#E87722", navy: "#17406E", dark: "#0D2137",
  light: "#F4F8FC", white: "#FFFFFF", gray: "#64748B",
  success: "#22C55E", danger: "#EF4444", purple: "#7C3AED"
};

// ─── GLOBAL STYLES ─────────────────────────────────────────────────────────────
const GlobalStyle = ({ dark }) => (
  <style>{`
    :root {
      --orange:${B.orange};--navy:${B.navy};--dark:${B.dark};
      --bg:${dark?"#0f172a":"#EEF2F7"};
      --surface:${dark?"#1e293b":"#fff"};
      --surface2:${dark?"#273344":"#F4F8FC"};
      --border:${dark?"rgba(255,255,255,.08)":"#E8EDF4"};
      --text:${dark?"#f1f5f9":"#0D2137"};
      --text2:${dark?"#94a3b8":"#64748B"};
      --sidebar-bg:${dark?"linear-gradient(180deg,#0f172a 0%,#1e293b 100%)":"linear-gradient(180deg,#0D2137 0%,#17406E 100%)"};
      --topbar-bg:${dark?"#1e293b":"#fff"};
      --input-bg:${dark?"#273344":"#F8FAFD"};
      --input-border:${dark?"rgba(255,255,255,.12)":"#E5EBF5"};
      --card-shadow:${dark?"0 1px 8px rgba(0,0,0,.3)":"0 1px 8px rgba(23,64,110,.07),0 4px 20px rgba(23,64,110,.05)"};
    }
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    html,body{height:100%;-webkit-text-size-adjust:100%;scroll-behavior:smooth;overflow-x:hidden}
    body{font-family:'Inter','Segoe UI',sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;transition:background .3s,color .3s}
    ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:var(--bg)}::-webkit-scrollbar-thumb{background:${B.navy};border-radius:3px}
    button{cursor:pointer;border:none;outline:none;font-family:inherit;-webkit-tap-highlight-color:transparent}
    input,textarea,select{font-family:inherit;outline:none;background:var(--input-bg);color:var(--text);border-color:var(--input-border)}
    a{color:inherit;text-decoration:none}
    img,video,canvas,svg{max-width:100%}
    /* Never let anything force the page to scroll sideways on small devices */
    #root{overflow-x:hidden;max-width:100vw}

    @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes modalIn{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}
    @keyframes slideDown{from{opacity:0;transform:translateY(-12px)}to{opacity:1;transform:translateY(0)}}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
    .fadeIn{animation:fadeIn .3s ease both}
    .spin{animation:spin 1s linear infinite}

    /* CARDS */
    .card{background:var(--surface);border-radius:16px;box-shadow:var(--card-shadow);transition:box-shadow .2s,transform .2s;border:1px solid var(--border)}
    .card:hover{box-shadow:0 4px 28px rgba(23,64,110,.15);transform:translateY(-2px)}
    .card-flat{background:var(--surface);border-radius:16px;box-shadow:var(--card-shadow);border:1px solid var(--border)}

    /* STAT CARDS */
    .stat-card{background:var(--surface);border-radius:14px;box-shadow:var(--card-shadow);padding:16px 18px;display:flex;align-items:center;gap:14px;border:1px solid var(--border);transition:transform .2s,box-shadow .2s}
    .stat-card:hover{transform:translateY(-2px)}
    .stat-card-icon{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .stat-card-val{font-size:22px;font-weight:800;color:var(--text);line-height:1.1}
    .stat-card-lbl{font-size:12px;color:var(--text2);margin-top:2px;font-weight:500}

    /* GRID */
    .stat-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}

    /* BUTTONS */
    .btn{cursor:pointer;border:none;font-family:inherit;display:inline-flex;align-items:center;gap:7px;font-weight:600;font-size:14px;border-radius:10px;transition:all .18s;padding:10px 20px;white-space:nowrap}
    .btn-primary{background:linear-gradient(135deg,${B.orange},#d4601a);color:#fff;box-shadow:0 2px 10px rgba(232,119,34,.3)}
    .btn-primary:hover{opacity:.92;transform:translateY(-1px);box-shadow:0 4px 16px rgba(232,119,34,.4)}
    .btn-primary:active{transform:scale(.97)}
    .btn-primary:disabled{opacity:.4;cursor:not-allowed;transform:none;box-shadow:none}
    .btn-secondary{background:var(--surface2);color:var(--text);border:1px solid var(--border)}
    .btn-secondary:hover{background:var(--border)}
    .btn-outline{background:transparent;border:2px solid ${B.navy};color:${B.navy}}
    .btn-outline:hover{background:${B.navy};color:#fff}
    .btn-danger{background:linear-gradient(135deg,#EF4444,#dc2626);color:#fff}
    .btn-danger:hover{opacity:.9}
    .btn-ghost{background:none;color:var(--text2);border:none}
    .btn-ghost:hover{color:var(--text);background:var(--surface2)}
    /* Login button sits on the dark navy nav — keep its hover/active subtle instead of the bright light surface */
    .landing-nav .btn-ghost:hover{color:#fff;background:rgba(255,255,255,.1)}
    .landing-nav .btn-ghost:active{background:rgba(255,255,255,.14)}
    .btn-sm{padding:7px 14px;font-size:13px}
    .btn-xs{padding:5px 10px;font-size:12px}
    .btn-lg{padding:14px 32px;font-size:16px}

    /* BADGES */
    .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.4px}
    .badge-orange{background:#FFF0E5;color:${B.orange}}
    .badge-navy{background:#E5EBF5;color:${B.navy}}
    .badge-green{background:#DCFCE7;color:#16A34A}
    .badge-red{background:#FEE2E2;color:#DC2626}
    .badge-purple{background:#F3E8FF;color:#7C3AED}
    .badge-yellow{background:#FEF9C3;color:#A16207}

    /* PROGRESS */
    .progress-track{background:var(--surface2);border-radius:999px;overflow:hidden}
    .progress-fill{background:linear-gradient(90deg,${B.orange},#f0a050);border-radius:999px;height:100%;transition:width .6s cubic-bezier(.4,0,.2,1)}

    /* SIDEBAR */
    .sidebar{width:248px;height:100vh;height:100dvh;background:var(--sidebar-bg);display:flex;flex-direction:column;gap:2px;padding:16px 10px 24px;position:fixed;left:0;top:0;z-index:200;transition:transform .3s cubic-bezier(.4,0,.2,1);overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.15) transparent}
    .sidebar-item{display:flex;align-items:center;gap:11px;padding:11px 14px;border-radius:10px;color:rgba(255,255,255,.65);font-size:14px;font-weight:500;cursor:pointer;transition:all .2s;position:relative}
    .sidebar-item:hover{background:rgba(255,255,255,.1);color:#fff}
    .sidebar-item.active{background:rgba(232,119,34,.2);color:${B.orange};font-weight:600}
    .sidebar-item.active::before{content:"";position:absolute;left:0;top:50%;transform:translateY(-50%);width:3px;height:60%;background:${B.orange};border-radius:0 2px 2px 0}
    .sidebar-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:199;backdrop-filter:blur(3px)}
    .hamburger{display:none;background:none;border:none;cursor:pointer;padding:6px;border-radius:8px;-webkit-tap-highlight-color:transparent}
    .main-layout{margin-left:248px;min-height:100vh;overflow-x:hidden}

    /* TOP BAR */
    .top-bar{background:var(--topbar-bg);height:62px;padding:0 24px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100;box-shadow:0 1px 6px rgba(0,0,0,.04);transition:background .3s}
    .top-bar-search{display:flex;align-items:center;gap:8px;background:var(--surface2);border-radius:10px;padding:8px 14px;width:240px;border:1px solid var(--border);transition:all .2s}
    .top-bar-search:focus-within{border-color:${B.navy};box-shadow:0 0 0 3px rgba(23,64,110,.08);width:280px}
    .top-bar-search input{background:none;border:none;font-size:13px;color:var(--text);width:100%}
    .top-bar-search input::placeholder{color:var(--text2)}
    .page-content{padding:24px;max-width:1400px;width:100%}

    /* FORMS */
    .input-field{width:100%;padding:11px 14px;border-radius:10px;border:1.5px solid var(--input-border);background:var(--input-bg);font-size:14px;transition:border .2s,box-shadow .2s;color:var(--text)}
    .input-field:focus{border-color:${B.navy};background:var(--surface);box-shadow:0 0 0 3px rgba(23,64,110,.08)}
    .form-group{margin-bottom:16px}
    .form-label{display:block;font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px}
    select.input-field option{background:var(--surface);color:var(--text)}

    /* AUTH SCREEN — always light themed (white card on navy bg looks right in both modes).
       Pins theme vars to their light values so labels/inputs never go invisible in dark mode. */
    .auth-scope{--surface:#fff;--surface2:#F4F8FC;--border:#E8EDF4;--text:#0D2137;--text2:#64748B;--input-bg:#F8FAFD;--input-border:#E5EBF5;color:var(--text)}
    .auth-scope input,.auth-scope textarea,.auth-scope select{background:var(--input-bg);color:var(--text);border-color:var(--input-border)}

    /* TABLES */
    .data-table{width:100%;border-collapse:collapse}
    .data-table th{background:var(--surface2);padding:12px 16px;text-align:left;font-size:11px;font-weight:700;color:var(--text2);letter-spacing:.6px;text-transform:uppercase;white-space:nowrap}
    .data-table td{padding:13px 16px;border-bottom:1px solid var(--border);font-size:14px;color:var(--text)}
    .data-table tr:last-child td{border-bottom:none}
    .data-table tbody tr:hover td{background:var(--surface2)}

    /* MODAL */
    .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:99999;padding:16px;backdrop-filter:blur(4px)}
    .modal-box{background:var(--surface);border-radius:20px;padding:28px;width:100%;max-width:560px;animation:modalIn .25s ease;max-height:90vh;overflow-y:auto;border:1px solid var(--border);position:relative;z-index:100000}

    /* TOGGLE */
    .toggle{width:44px;height:24px;border-radius:12px;position:relative;cursor:pointer;transition:background .2s;flex-shrink:0}
    .toggle-knob{width:18px;height:18px;border-radius:50%;background:#fff;position:absolute;top:3px;transition:left .2s;box-shadow:0 1px 4px rgba(0,0,0,.2)}

    /* TABS */
    .tab-bar{display:flex;gap:4px;background:var(--surface2);border-radius:12px;padding:4px}
    .tab{padding:8px 16px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;transition:all .18s;color:var(--text2);background:transparent;border:none;white-space:nowrap}
    .tab.active{background:var(--surface);color:${B.navy};box-shadow:0 1px 6px rgba(0,0,0,.1)}

    /* BOTTOM NAV */
    .bottom-nav{display:none;position:fixed;bottom:0;left:0;right:0;background:var(--topbar-bg);border-top:1px solid var(--border);z-index:150;padding:4px 0;padding-bottom:env(safe-area-inset-bottom,4px);box-shadow:0 -2px 16px rgba(0,0,0,.08)}
    .bottom-nav-items{display:flex;justify-content:space-around;align-items:center}
    .bottom-nav-item{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 8px;cursor:pointer;color:var(--text2);font-size:10px;font-weight:600;background:none;border:none;min-width:48px;border-radius:8px;transition:color .15s}
    .bottom-nav-item.active{color:${B.orange}}

    /* HERO */
    .dash-hero{background:linear-gradient(135deg,#0D2137 0%,#17406E 60%,#1a4d8a 100%);border-radius:18px;padding:24px;color:#fff;margin-bottom:16px;position:relative;overflow:hidden}
    .dash-hero::before{content:"";position:absolute;right:-40px;top:-40px;width:200px;height:200px;border-radius:50%;background:rgba(232,119,34,.1);pointer-events:none}
    .dash-hero::after{content:"";position:absolute;left:-20px;bottom:-60px;width:180px;height:180px;border-radius:50%;background:rgba(255,255,255,.03);pointer-events:none}

    /* CHIPS */
    .chip{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600;background:var(--surface2);color:var(--text);border:1px solid var(--border)}
    .leaderboard-row{display:grid;grid-template-columns:36px 1fr auto;align-items:center;gap:14px;padding:12px 16px;border-radius:12px;margin-bottom:8px;background:var(--surface);box-shadow:var(--card-shadow);border:1px solid var(--border)}

    /* NOTIFICATION DOT */
    .notif-dot{position:absolute;top:-3px;right:-3px;width:17px;height:17px;border-radius:50%;background:${B.orange};color:#fff;font-size:9px;font-weight:800;display:flex;align-items:center;justify-content:center;border:2px solid var(--topbar-bg)}

    /* DROPDOWN */
    .dropdown{position:absolute;background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.15);z-index:999;animation:slideDown .2s ease;min-width:200px}
    .dropdown-item{display:flex;align-items:center;gap:10px;padding:11px 16px;font-size:14px;font-weight:500;color:var(--text);cursor:pointer;transition:background .15s;border-radius:10px;margin:3px}
    .dropdown-item:hover{background:var(--surface2)}

    /* COURSE CARD */
    .course-card{background:var(--surface);border-radius:16px;overflow:hidden;cursor:pointer;border:1px solid var(--border);transition:transform .2s,box-shadow .2s}
    .course-card:hover{transform:translateY(-4px);box-shadow:0 8px 32px rgba(23,64,110,.12)}

    /* STATS SKELETON */
    .skeleton{background:linear-gradient(90deg,var(--surface2) 25%,var(--border) 50%,var(--surface2) 75%);background-size:200% 100%;animation:pulse 1.5s ease-in-out infinite;border-radius:8px}

    /* SECTION HEADER */
    .section-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}
    .section-title{font-size:18px;font-weight:800;color:var(--text)}

    /* LANDING SPECIFIC */
    .landing-nav{display:flex;align-items:center;justify-content:space-between;padding:18px clamp(16px,4vw,64px);border-bottom:1px solid rgba(255,255,255,.1);position:sticky;top:0;z-index:50;backdrop-filter:blur(10px);background:rgba(13,33,55,.8)}
    .landing-nav-links{display:flex;gap:28px;align-items:center}
    .landing-nav-link{color:rgba(255,255,255,.7);font-size:14px;font-weight:500;cursor:pointer;transition:color .2s}
    .landing-nav-link:hover{color:#fff}
    .feature-card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:24px;transition:all .25s;cursor:default}
    .feature-card:hover{background:rgba(255,255,255,.08);transform:translateY(-3px)}
    .contact-card:hover{background:rgba(255,255,255,.1);border-color:rgba(232,119,34,.4);transform:translateY(-2px)}
    /* Quiz anti-cheat: discourage text selection / copy / image-drag while a quiz is active */
    .quiz-lock, .quiz-lock *{ -webkit-user-select:none !important; user-select:none !important; }
    .quiz-lock img{ -webkit-user-drag:none; pointer-events:none; }
    .testimonial-card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:24px}
    .stat-hero{text-align:center}
    .stat-hero-num{font-size:clamp(28px,4vw,42px);font-weight:900;color:${B.orange};line-height:1}
    .stat-hero-lbl{font-size:13px;color:rgba(255,255,255,.55);margin-top:4px}

    /* RESPONSIVE */
    @media(min-width:769px){
      .stat-grid{grid-template-columns:repeat(3,1fr);gap:16px}
      .stat-card-val{font-size:26px}
      .mobile-stack{display:grid;grid-template-columns:1fr 1fr;gap:20px}
    }
    @media(min-width:1200px){
      .stat-grid{grid-template-columns:repeat(4,1fr)}
    }

    /* ── MOBILE LAYOUT ── */
    @media(max-width:768px){
      /* Sidebar */
      .sidebar{transform:translateX(-100%);width:270px}
      .sidebar.open{transform:translateX(0)}
      .sidebar-overlay{display:block}
      .sidebar-overlay.hidden{display:none}
      .main-layout{margin-left:0!important}
      .hamburger{display:flex;align-items:center;justify-content:center}

      /* Top bar — cleaner, taller tap targets */
      .top-bar{padding:0 12px;height:56px}
      .top-bar-search{display:none}

      /* Page padding — generous sides, room for bottom nav */
      .page-content{padding:12px;padding-bottom:96px}

      /* Stats — 2 columns, taller cards */
      .stat-grid{grid-template-columns:1fr 1fr;gap:10px}
      .stat-card{padding:14px 12px;gap:12px;border-radius:12px}
      .stat-card-icon{width:40px;height:40px;border-radius:10px}
      .stat-card-val{font-size:20px}
      .stat-card-lbl{font-size:11px}

      /* Bottom nav */
      .bottom-nav{display:block}

      /* Landing */
      .landing-nav-links{display:none}
      /* Compact landing nav so logo + buttons don't crowd each other on phones */
      .landing-nav{padding:12px 14px;gap:10px}
      .landing-nav img{height:28px}
      .landing-nav .btn{padding:8px 13px;font-size:13px}

      /* Modals — full width, no side gaps */
      .modal-overlay{padding:10px}
      .modal-box{padding:20px;border-radius:18px;max-height:95vh}
      /* Stack multi-column form rows inside modals on phones */
      .modal-box div[style*="grid-template-columns"]{grid-template-columns:1fr!important}

      /* Tables — scrollable, readable */
      .data-table{font-size:12px}
      .data-table th,.data-table td{padding:8px 10px;white-space:nowrap}

      /* Cards stacking */
      .mobile-stack{display:flex;flex-direction:column;gap:12px}

      /* Hero banner — more compact */
      .dash-hero{padding:18px;border-radius:14px;margin-bottom:12px}

      /* Leaderboard rows */
      .leaderboard-row{gap:10px;padding:10px 12px;border-radius:10px}

      /* Section headers — wrap title + action button instead of squeezing */
      .section-header{margin-bottom:14px;flex-wrap:wrap;gap:10px}
      .section-title{font-size:20px}

      /* Dropdowns — full width on mobile */
      .dropdown{left:8px;right:8px;width:auto!important}

      /* Notifications panel */
      .notif-dot{width:15px;height:15px;font-size:8px}

      /* Course cards — full width on mobile */
      .course-card{border-radius:12px}

      /* AI tutor height fix */
      .ai-tutor-container{height:calc(100vh - 140px)}

      /* Top bar — hide name text on mobile, just show avatar */
      .topbar-name{display:none}
      .topbar-chevron{display:none}

      /* Section title smaller on mobile */
      .section-title{font-size:18px}

      /* Hide page label in top bar on mobile (hamburger takes space) */
      .top-bar-label{display:none}
    }

    /* ── SMALL PHONES ── */
    @media(max-width:390px){
      .stat-grid{gap:8px}
      .stat-card{padding:11px 10px;gap:9px}
      .stat-card-icon{width:36px;height:36px}
      .stat-card-val{font-size:18px}
      .stat-card-lbl{font-size:10px}
      .page-content{padding:8px;padding-bottom:90px}
      .dash-hero{padding:14px}
      .section-title{font-size:18px}
      .btn{font-size:13px}
      .btn-lg{padding:12px 24px;font-size:15px}
      /* Very small phones: hide the redundant Login button (Get Started opens the same page) */
      .landing-nav .btn-ghost{display:none}
      .landing-nav .btn{padding:8px 12px;font-size:12px}
    }

    /* ── RESPONSIVE INLINE GRIDS ──
       Inline grid-template-columns beat media queries, so collapse fixed
       multi-column grids here with !important so nothing overflows on small screens. */
    @media(max-width:768px){
      /* 3- and 4-column inline grids → 2 columns on tablets/large phones */
      [style*="1fr 1fr 1fr"]{grid-template-columns:repeat(2,1fr)!important}
    }
    @media(max-width:560px){
      /* Any fixed multi-column inline grid → single column on phones */
      [style*="1fr 1fr"]{grid-template-columns:1fr!important}
    }
  `}</style>
);

// ─── ICONS ─────────────────────────────────────────────────────────────────────
const Ico = ({ n, s = 18, c = "currentColor" }) => {
  const paths = {
    home: <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
    users: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    quiz: <><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></>,
    code: <><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></>,
    trophy: <><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" /><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" /><path d="M4 22h16" /><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" /><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" /><path d="M18 2H6v7a6 6 0 0 0 12 0V2z" /></>,
    zap: <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />,
    chart: <><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></>,
    lock: <><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>,
    bell: <><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></>,
    play: <polygon points="5 3 19 12 5 21 5 3" />,
    check: <polyline points="20 6 9 17 4 12" />,
    x: <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>,
    plus: <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>,
    edit: <><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></>,
    trash: <><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>,
    logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>,
    ai: <><path d="M12 2a10 10 0 1 0 10 10" /><path d="M12 8v4l3 3" /><path d="M18 2l4 4-4 4" /><path d="M22 2l-4 4" /></>,
    flame: <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />,
    book: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></>,
    cert: <><circle cx="12" cy="8" r="6" /><path d="M15.477 12.89L17 22l-5-3-5 3 1.523-9.11" /></>,
    star: <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />,
    forum: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
    progress: <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />,
    user: <><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>,
    download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>,
    assign: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></>,
    send: <><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></>,
    refresh: <><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></>,
    sun: <><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></>,
    moon: <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />,
    search: <><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>,
    menu: <><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" /></>,
    arrowL: <><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></>,
    chevron: <polyline points="6 9 12 15 18 9" />,
    globe: <><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></>,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
    clock: <><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>,
    mail: <><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" /></>,
    phone: <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.41 2 2 0 0 1 3.59 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.59a16 16 0 0 0 6.29 6.29l.95-.95a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />,
    instagram: <><rect x="2" y="2" width="20" height="20" rx="5" ry="5" /><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" /><line x1="17.5" y1="6.5" x2="17.51" y2="6.5" /></>,
    linkedin: <><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" /><rect x="2" y="9" width="4" height="12" /><circle cx="4" cy="4" r="2" /></>,
  };
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {paths[n]}
    </svg>
  );
};

// ─── BASE COMPONENTS ──────────────────────────────────────────────────────────
const Spinner = ({ size = 24, color }) => (
  <div className="spin" style={{ width: size, height: size, border: `3px solid rgba(0,0,0,.08)`, borderTopColor: color || B.orange, borderRadius: "50%" }} />
);

const ProgressBar = ({ value, height = 8, showLabel = false, color }) => (
  <div>
    {showLabel && <div style={{ fontSize: 12, color: "var(--text2)", marginBottom: 4 }}>{Math.round(value)}% complete</div>}
    <div className="progress-track" style={{ height }}>
      <div className="progress-fill" style={{ width: `${Math.min(100, value)}%`, ...(color ? { background: color } : {}) }} />
    </div>
  </div>
);

const StatCard = ({ label, value, icon, color = B.orange, delta, sub, onClick }) => (
  <div className="stat-card fadeIn" style={{ cursor: onClick ? "pointer" : "default" }} onClick={onClick}>
    <div className="stat-card-icon" style={{ background: `${color}18` }}>
      <Ico n={icon} s={22} c={color} />
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="stat-card-val">{value}</div>
      <div className="stat-card-lbl">{label}</div>
      {delta && <div style={{ fontSize: 11, color: B.success, marginTop: 2, fontWeight: 600 }}>↑ {delta}</div>}
      {sub && <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 2 }}>{sub}</div>}
    </div>
  </div>
);

// Rendered through a portal to <body> so the fixed overlay always covers the full
// viewport — never trapped by an ancestor's transform (e.g. the .fadeIn page wrapper,
// whose residual transform:translateY(0) would otherwise become the containing block).
const Modal = ({ title, onClose, children, wide }) => {
  // Lock background scroll while the modal is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
  }, [onClose]);

  return createPortal(
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: wide ? 720 : 560 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: "var(--text)" }}>{title}</h2>
          <button onClick={onClose} className="btn-ghost" style={{ borderRadius: 8, padding: 4 }}><Ico n="x" s={20} /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
};

// ─── IN-APP SLIDE VIEWER (no download / no share) ──────────────────────────────
function dataUrlToUint8(dataUrl) {
  const base64 = (dataUrl || "").split(",")[1] || "";
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// ─── MCQ-FROM-PDF IMPORT ───────────────────────────────────────────────────────
// Extract text lines from a PDF in the browser (pdf.js), grouping text items by
// their vertical position and inserting spaces across horizontal gaps.
async function extractPdfLines(uint8) {
  const doc = await pdfjsLib.getDocument({ data: uint8 }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const rows = {};
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]);
      (rows[y] = rows[y] || []).push({ x: it.transform[4], w: it.width || 0, s: it.str });
    }
    Object.keys(rows).map(Number).sort((a, b) => b - a).forEach(y => {
      const items = rows[y].sort((a, b) => a.x - b.x);
      let line = "", prevEnd = null;
      for (const it of items) {
        if (prevEnd != null && it.x - prevEnd > 1 && !line.endsWith(" ") && !it.s.startsWith(" ")) line += " ";
        line += it.s;
        prevEnd = it.x + it.w;
      }
      line = line.replace(/\s+/g, " ").trim();
      if (line) lines.push(line);
    });
  }
  return lines;
}

// Parse MCQs from extracted lines. Supported layout (one option per line):
//   1. / 1) / Q1.  question text
//   A) / A. / (A) / a)  option text        (up to 8 options; mark correct with * )
//   Answer: B / Ans: b / Correct: C        (per-question answer)
//   ...or a trailing "Answers: 1-B 2-C 3-A" key block.
function parseMcqLines(lines) {
  const questions = [];
  let cur = null, keyMode = false;
  const optRe = /^\(?\s*([A-Ha-h])\s*[).:\-]\s*(.+)$/;
  const qRe = /^(?:Q(?:uestion)?\.?\s*)?(\d{1,3})\s*[).:\-]\s*(.+)$/i;
  const ansRe = /^(?:Ans(?:wer)?|Correct(?:\s*(?:Answer|Option))?)\s*[:.\-)]?\s*\(?\s*([A-Ha-h]|\d)\s*\)?/i;
  const keyHeaderRe = /^(?:answer\s*key|answers)\s*[:.\-]?\s*$/i;
  const push = () => {
    if (cur && cur.q && cur.opts.length >= 2) { if (cur.ans == null) cur.ans = 0; questions.push(cur); }
    cur = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (keyHeaderRe.test(line)) { push(); keyMode = true; continue; }
    if (keyMode) {
      const re = /(\d{1,3})\s*[).:\-]?\s*\(?([A-Ha-h])\)?/g;
      let km;
      while ((km = re.exec(line))) {
        const qn = +km[1], idx = km[2].toUpperCase().charCodeAt(0) - 65;
        if (questions[qn - 1] && idx >= 0 && idx < questions[qn - 1].opts.length) questions[qn - 1].ans = idx;
      }
      continue;
    }
    let m;
    if ((m = line.match(ansRe))) {
      if (cur) {
        const k = m[1];
        const idx = /\d/.test(k) ? parseInt(k, 10) - 1 : k.toUpperCase().charCodeAt(0) - 65;
        if (idx >= 0 && idx < cur.opts.length) cur.ans = idx;
      }
      continue;
    }
    if ((m = line.match(optRe))) {
      if (cur && cur.opts.length < 8) {
        let txt = m[2].trim(), correct = false;
        if (/\*+\s*$/.test(txt) || /\((?:correct|ans(?:wer)?)\)/i.test(txt)) {
          correct = true;
          txt = txt.replace(/\*+\s*$/, "").replace(/\((?:correct|ans(?:wer)?)\)/ig, "").trim();
        }
        cur.opts.push(txt);
        if (correct) cur.ans = cur.opts.length - 1;
      }
      continue;
    }
    if ((m = line.match(qRe))) { push(); cur = { q: m[2].trim(), opts: [], ans: null }; continue; }
    // continuation line — extend the question text or the last option
    if (cur) {
      if (cur.opts.length === 0) cur.q += " " + line;
      else cur.opts[cur.opts.length - 1] += " " + line;
    }
  }
  push();
  return questions;
}

// View-only PDF slideshow for students. Renders the PDF page-by-page onto a
// canvas (Prev / Next, page counter, full-screen) with NO download and no
// right-click / Ctrl+S / Ctrl+P — the original file is never handed over.
const SlideViewer = ({ materialId, title, onClose, onReachedEnd }) => {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const containerRef = useRef(null);
  const reachedRef = useRef(false); // fire onReachedEnd only once per material
  const [pdf, setPdf] = useState(null);
  const [imgSrc, setImgSrc] = useState(null);
  const [page, setPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [isFs, setIsFs] = useState(false);
  const [fit, setFit] = useState(0); // bump to re-fit on resize / orientation / fullscreen
  const [speaking, setSpeaking] = useState(false); // read-aloud (text-to-speech) active
  const [showAudioOpts, setShowAudioOpts] = useState(false); // voice/speed dropdown
  const speakingRef = useRef(false);
  const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;
  const [voices, setVoices] = useState([]);
  const [rate, setRate] = useState(() => Number(localStorage.getItem("lms_tts_rate")) || 1.25);
  const [gender, setGender] = useState(() => localStorage.getItem("lms_tts_gender") || "female");
  const rateRef = useRef(rate);
  const genderRef = useRef(gender);
  useEffect(() => { rateRef.current = rate; localStorage.setItem("lms_tts_rate", String(rate)); }, [rate]);
  useEffect(() => { genderRef.current = gender; localStorage.setItem("lms_tts_gender", gender); }, [gender]);

  // Load the device's available voices (they populate asynchronously).
  useEffect(() => {
    if (!ttsSupported) return;
    const load = () => setVoices(window.speechSynthesis.getVoices() || []);
    load();
    window.speechSynthesis.onvoiceschanged = load;
    return () => { try { window.speechSynthesis.onvoiceschanged = null; } catch {} };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onResize = () => setFit(f => f + 1);
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => { window.removeEventListener("resize", onResize); window.removeEventListener("orientationchange", onResize); };
  }, []);

  // Load the material lazily when the modal opens
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(""); setPdf(null); setImgSrc(null); setNumPages(0); setPage(1);
    (async () => {
      try {
        const data = await GET(`/materials/${materialId}/download`);
        if (cancelled) return;
        const sig = `${data.fileType || ""} ${data.fileName || ""}`.toLowerCase();
        if (!data.fileData) setErr("No file is attached to this material.");
        else if (sig.includes("pdf")) {
          const doc = await pdfjsLib.getDocument({ data: dataUrlToUint8(data.fileData) }).promise;
          if (cancelled) return;
          setPdf(doc); setNumPages(doc.numPages);
        } else if (/(image|png|jpe?g|gif|webp|svg|bmp)/.test(sig)) {
          setImgSrc(data.fileData);
        } else {
          setErr("Only PDF or image materials can be presented here.");
        }
      } catch { if (!cancelled) setErr("Could not open this material."); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [materialId]);

  // Render the current PDF page to the canvas (crisp at device pixel ratio)
  useEffect(() => {
    if (!pdf || !canvasRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const p = await pdf.getPage(page);
        if (cancelled) return;
        const canvas = canvasRef.current;
        const wrap = wrapRef.current;
        const availW = (wrap?.clientWidth || 800) - 24;
        const availH = (wrap?.clientHeight || 600) - 24;
        const base = p.getViewport({ scale: 1 });
        const scale = Math.min(3, Math.max(0.3, Math.min(availW / base.width, availH / base.height)));
        const dpr = window.devicePixelRatio || 1;
        const viewport = p.getViewport({ scale });
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        await p.render({ canvasContext: ctx, viewport }).promise;
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [pdf, page, isFs, fit]);

  // Full-screen toggle (browser Fullscreen API, with immersive state fallback)
  const toggleFs = () => {
    const el = containerRef.current;
    const next = !isFs;
    setIsFs(next);
    try {
      if (next) (el?.requestFullscreen || el?.webkitRequestFullscreen || el?.webkitRequestFullScreen)?.call(el);
      else (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    } catch {}
  };

  // Keyboard nav + block Ctrl/Cmd+S / +P; lock background scroll
  useEffect(() => {
    const onKey = e => {
      if (e.key === "ArrowRight" || e.key === " ") setPage(p => Math.min(numPages || 1, p + 1));
      else if (e.key === "ArrowLeft") setPage(p => Math.max(1, p - 1));
      else if (e.key === "Escape") onClose();
      else if ((e.ctrlKey || e.metaKey) && ["s", "p"].includes((e.key || "").toLowerCase())) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [numPages, onClose]);

  // Reset the "reached the end" latch whenever a new material is opened.
  useEffect(() => { reachedRef.current = false; }, [materialId]);

  // Consider the material "read to the end" when the student reaches the last PDF
  // page (or opens a single-page PDF / image). Fires the callback exactly once so
  // the parent can unlock module completion.
  useEffect(() => {
    if (reachedRef.current) return;
    const pdfAtEnd = numPages > 0 && page >= numPages;
    const imageOpened = !!imgSrc;
    if (pdfAtEnd || imageOpened) {
      reachedRef.current = true;
      onReachedEnd && onReachedEnd();
    }
  }, [page, numPages, imgSrc]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── READ ALOUD (audio) ──────────────────────────────────────────────────────
  // Pulls the real text out of the PDF (pdf.js) and speaks it with the browser's
  // built-in speech engine — instant, offline, free, works on every PDF that has
  // selectable text. Reads the current page, then auto-advances through the rest.
  const stopSpeak = () => {
    speakingRef.current = false;
    setSpeaking(false);
    try { window.speechSynthesis.cancel(); } catch {}
  };
  const getPageText = async n => {
    try {
      const pg = await pdf.getPage(n);
      const tc = await pg.getTextContent();
      return tc.items.map(it => it.str).join(" ").replace(/\s+/g, " ").trim();
    } catch { return ""; }
  };
  // Choose a voice matching the chosen gender. Voice metadata has no gender flag,
  // so we match on well-known voice names (Windows/Chrome/Android/iOS), preferring
  // English voices; falls back to any available voice.
  const pickVoice = () => {
    const list = voices.length ? voices : (ttsSupported ? window.speechSynthesis.getVoices() : []);
    const en = list.filter(v => /^en/i.test(v.lang));
    const pool = en.length ? en : list;
    const femaleRe = /\bfemale\b|zira|hazel|susan|samantha|victoria|karen|moira|tessa|fiona|serena|heera|linda|eva|aria|jenny|michelle|catherine|sonia|neerja|swara|salli|joanna|kendra/i;
    const maleRe = /\bmale\b|david|mark|george|james|guy|ravi|tony|brian|christopher|eric|roger|daniel|thomas|oliver|prabhat|matthew|justin/i;
    const want = genderRef.current === "male" ? maleRe : femaleRe;
    return pool.find(v => want.test(v.name)) || pool[0] || null;
  };
  const readAloud = async () => {
    if (!pdf || !ttsSupported) return;
    const synth = window.speechSynthesis;
    synth.cancel();
    speakingRef.current = true;
    setSpeaking(true);
    const speakPage = async n => {
      if (!speakingRef.current) return;
      setPage(n); // show the page being read
      const text = await getPageText(n);
      if (!speakingRef.current) return;
      // Split into sentence-sized chunks — dodges the browser cutoff on long
      // utterances and keeps narration flowing smoothly.
      const chunks = (text.match(/[^.!?]+[.!?]*/g) || (text ? [text] : [])).map(s => s.trim()).filter(Boolean);
      if (chunks.length === 0) { // page has no selectable text (e.g. scanned image)
        if (n < numPages) return speakPage(n + 1);
        return stopSpeak();
      }
      let idx = 0;
      const next = () => {
        if (!speakingRef.current) return;
        if (idx >= chunks.length) {
          if (n < numPages) return speakPage(n + 1);
          return stopSpeak();
        }
        const u = new SpeechSynthesisUtterance(chunks[idx]);
        const v = pickVoice();
        if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = "en-IN"; }
        u.rate = rateRef.current; u.pitch = 1;
        u.onend = () => { idx += 1; next(); };
        u.onerror = () => { idx += 1; next(); };
        synth.speak(u);
      };
      next();
    };
    speakPage(page);
  };
  const toggleSpeak = () => { if (speaking) stopSpeak(); else readAloud(); };
  // Change speed / voice — applies immediately (restarts the current page if playing).
  const changeRate = r => { rateRef.current = r; setRate(r); if (speakingRef.current) readAloud(); };
  const changeGender = g => { genderRef.current = g; setGender(g); if (speakingRef.current) readAloud(); };

  // Compact audio-settings dropdown (voice + speed) — keeps the toolbar uncluttered,
  // especially on phones. `pos` places it under whichever gear button opened it.
  const renderAudioPanel = pos => (
    <div style={{ position: "absolute", zIndex: 6, background: "#1b2536", border: "1px solid rgba(255,255,255,.15)", borderRadius: 12, padding: 14, boxShadow: "0 12px 40px rgba(0,0,0,.55)", width: 220, ...pos }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,.5)", textTransform: "uppercase", letterSpacing: .5, marginBottom: 8 }}>Voice</div>
      <div style={{ display: "flex", border: "1px solid rgba(255,255,255,.2)", borderRadius: 9, overflow: "hidden", marginBottom: 14 }}>
        <button onClick={() => changeGender("female")} style={{ flex: 1, padding: "9px 8px", fontSize: 13, fontWeight: 700, background: gender === "female" ? B.orange : "transparent", color: "#fff", border: "none", cursor: "pointer" }}>♀ Female</button>
        <button onClick={() => changeGender("male")} style={{ flex: 1, padding: "9px 8px", fontSize: 13, fontWeight: 700, background: gender === "male" ? B.orange : "transparent", color: "#fff", border: "none", cursor: "pointer" }}>♂ Male</button>
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(255,255,255,.5)", textTransform: "uppercase", letterSpacing: .5, marginBottom: 8 }}>Speed</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
        {[0.75, 1, 1.25, 1.5, 1.75, 2].map(r => (
          <button key={r} onClick={() => changeRate(r)} style={{ padding: "8px 4px", fontSize: 12.5, fontWeight: 700, borderRadius: 8, background: rate === r ? B.orange : "rgba(255,255,255,.08)", color: "#fff", border: `1px solid ${rate === r ? B.orange : "rgba(255,255,255,.18)"}`, cursor: "pointer" }}>{r}×</button>
        ))}
      </div>
    </div>
  );

  // Stop narration when the material changes or the viewer unmounts.
  useEffect(() => () => stopSpeak(), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { stopSpeak(); setShowAudioOpts(false); }, [materialId]); // eslint-disable-line react-hooks/exhaustive-deps

  return createPortal(
    <div ref={containerRef} onContextMenu={e => e.preventDefault()} style={{ position: "fixed", inset: 0, height: "100dvh", zIndex: 100000, background: "rgba(8,12,20,.97)", display: "flex", flexDirection: "column", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" }}>
      {!isFs && (
        <div style={{ position: "relative", padding: "12px 14px", color: "#fff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div style={{ fontWeight: 700, fontSize: 14, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title || "Material"}{numPages ? ` · ${page}/${numPages}` : ""}</div>
            <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
              {pdf && ttsSupported && (
                <>
                  <button onClick={toggleSpeak} className="btn btn-sm" style={{ background: speaking ? B.orange : "rgba(232,119,34,.18)", color: "#fff", border: `1px solid ${B.orange}`, fontWeight: 700, padding: "7px 12px" }}>
                    {speaking ? "⏸ Stop" : "🔊 Read Aloud"}
                  </button>
                  <button onClick={() => setShowAudioOpts(v => !v)} title="Voice & speed" className="btn btn-sm" style={{ background: showAudioOpts ? B.orange : "rgba(255,255,255,.1)", color: "#fff", border: "1px solid rgba(255,255,255,.25)", padding: "7px 11px", fontWeight: 700 }}>⚙</button>
                </>
              )}
              <button onClick={toggleFs} title="Full screen" className="btn btn-secondary btn-sm" style={{ padding: "7px 11px" }}>⛶</button>
              <button onClick={onClose} title="Close" className="btn btn-secondary btn-sm" style={{ padding: "7px 11px" }}>✕</button>
            </div>
          </div>
          {pdf && ttsSupported && showAudioOpts && renderAudioPanel({ top: "calc(100% - 2px)", right: 10 })}
        </div>
      )}
      {isFs && (
        <div style={{ position: "absolute", top: "max(10px, env(safe-area-inset-top))", right: 10, zIndex: 5, display: "flex", gap: 8, alignItems: "flex-start" }}>
          {pdf && ttsSupported && (
            <>
              <button onClick={toggleSpeak} style={{ background: speaking ? B.orange : "rgba(0,0,0,.55)", color: "#fff", border: `1px solid ${B.orange}`, borderRadius: 8, padding: "7px 12px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>{speaking ? "⏸ Stop" : "🔊 Read"}</button>
              <button onClick={() => setShowAudioOpts(v => !v)} style={{ background: showAudioOpts ? B.orange : "rgba(0,0,0,.55)", color: "#fff", border: "1px solid rgba(255,255,255,.25)", borderRadius: 8, padding: "7px 11px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>⚙</button>
            </>
          )}
          <button onClick={toggleFs} style={{ background: "rgba(0,0,0,.55)", color: "#fff", border: "1px solid rgba(255,255,255,.25)", borderRadius: 8, padding: "7px 12px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>✕ Exit</button>
          {pdf && ttsSupported && showAudioOpts && renderAudioPanel({ top: 48, right: 0 })}
        </div>
      )}
      <div ref={wrapRef} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", position: "relative", overflow: "hidden", padding: isFs ? 4 : 12, minHeight: 0 }}>
        {loading ? <Spinner size={42} color="#fff" />
          : err ? <div style={{ color: "#fff", maxWidth: 420, textAlign: "center", fontSize: 14, lineHeight: 1.6 }}>{err}</div>
          : imgSrc ? <img src={imgSrc} draggable={false} alt="" style={{ maxWidth: "100%", maxHeight: "100%", pointerEvents: "none", borderRadius: 6 }} />
          : <canvas ref={canvasRef} onContextMenu={e => e.preventDefault()} style={{ maxWidth: "100%", maxHeight: "100%", boxShadow: "0 10px 50px rgba(0,0,0,.55)", borderRadius: 4, background: "#fff" }} />}
      </div>
      {!err && numPages > 1 && (
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 16, padding: isFs ? "6px 10px" : 10, paddingBottom: isFs ? "max(6px, env(safe-area-inset-bottom))" : 10 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>← Prev</button>
          <span style={{ color: "#fff", fontSize: 13, fontWeight: 600 }}>Page {page} of {numPages}</span>
          <button className="btn btn-secondary btn-sm" onClick={() => setPage(p => Math.min(numPages, p + 1))} disabled={page >= numPages}>Next →</button>
        </div>
      )}
      {!isFs && <div style={{ textAlign: "center", color: "rgba(255,255,255,.4)", fontSize: 11, paddingBottom: 10 }}>🔒 View only — downloading and sharing are disabled</div>}
    </div>,
    document.body
  );
};

const Toggle = ({ checked, onChange, label }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
    <div className="toggle" style={{ background: checked ? B.orange : "#CBD5E1" }} onClick={() => onChange(!checked)}>
      <div className="toggle-knob" style={{ left: checked ? "23px" : "3px" }} />
    </div>
    {label && <span style={{ fontSize: 13, color: "var(--text2)", fontWeight: 500 }}>{label}</span>}
  </div>
);

const Toast = ({ msg, type = "success", onClose }) => createPortal(
  <div style={{ position: "fixed", top: 20, right: 20, zIndex: 99999, background: type === "error" ? B.danger : type === "info" ? B.navy : B.success, color: "#fff", padding: "12px 20px", borderRadius: 12, fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 10, boxShadow: "0 4px 20px rgba(0,0,0,.2)", animation: "slideDown .3s ease", maxWidth: 340 }}>
    <Ico n={type === "error" ? "x" : "check"} s={16} />
    {msg}
    <button onClick={onClose} style={{ background: "none", color: "#fff", opacity: .7, marginLeft: "auto" }}><Ico n="x" s={14} /></button>
  </div>,
  document.body
);

function useToast() {
  const [toast, setToast] = useState(null);
  const show = (msg, type = "success") => { setToast({ msg, type }); setTimeout(() => setToast(null), 3500); };
  const el = toast ? <Toast msg={toast.msg} type={toast.type} onClose={() => setToast(null)} /> : null;
  return [show, el];
}

const EmptyState = ({ icon, title, desc, action }) => (
  <div className="card" style={{ padding: 60, textAlign: "center" }}>
    <Ico n={icon} s={48} c="#CBD5E1" />
    <h3 style={{ fontWeight: 700, marginTop: 16, color: "var(--text)" }}>{title}</h3>
    <p style={{ color: "var(--text2)", fontSize: 14, marginTop: 8 }}>{desc}</p>
    {action && <div style={{ marginTop: 20 }}>{action}</div>}
  </div>
);


// ─── LANDING PAGE ──────────────────────────────────────────────────────────────
const LandingPage = ({ onGetStarted }) => {
  const features = [
    { icon: "book", title: "Structured Courses", desc: "Industry-designed curriculum for Python, SQL, Power BI, Excel & ML." },
    { icon: "ai", title: "AI Tutor", desc: "Get instant answers powered by Claude AI — available 24/7." },
    { icon: "code", title: "Coding Playground", desc: "Write and execute Python code directly in your browser." },
    { icon: "quiz", title: "Smart Quizzes", desc: "Adaptive assessments that test real understanding." },
    { icon: "trophy", title: "XP & Leaderboard", desc: "Earn XP, badges, and compete with your batch." },
    { icon: "cert", title: "Certificates", desc: "Verified certificates to share on LinkedIn." },
    { icon: "forum", title: "Community Forum", desc: "Ask, discuss, and collaborate with peers & instructors." },
    { icon: "assign", title: "Assignments", desc: "Submit work and get detailed feedback from instructors." },
  ];
  const testimonials = [
    { name: "Priyanka M.", role: "Data Analyst at TCS", text: "DhishaAI transformed my career. The structured curriculum and AI tutor helped me crack interviews confidently.", avatar: "P" },
    { name: "Karthik R.", role: "Business Analyst at Infosys", text: "The hands-on Python playground made coding click for me. Got placed within 3 months of completing the course.", avatar: "K" },
    { name: "Sneha T.", role: "BI Developer at Wipro", text: "Power BI certification from DhishaAI gave me the edge I needed. Highly structured and practical content.", avatar: "S" },
  ];
  const stats = [["2,000+", "Students Placed"], ["4.8★", "Average Rating"], ["15+", "Live Courses"], ["24/7", "AI Support"]];
  const courses = [
    { title: "Python for Data Analytics", tag: "BESTSELLER", color: "#4F46E5", lessons: 24, duration: "10 hrs" },
    { title: "SQL for Data Analysis", tag: "POPULAR", color: "#0EA5E9", lessons: 18, duration: "8 hrs" },
    { title: "Power BI Masterclass", tag: "NEW", color: "#F59E0B", lessons: 20, duration: "9 hrs" },
    { title: "Machine Learning Basics", tag: "ADVANCED", color: "#10B981", lessons: 30, duration: "15 hrs" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,#0D2137 0%,#17406E 55%,#1a4d8a 100%)", overflowX: "hidden" }}>
      {/* Sticky Nav */}
      <nav className="landing-nav">
        <div style={{ background: "rgba(255,255,255,.95)", borderRadius: 10, padding: "6px 14px" }}>
          <img src="/dhishaai-logo.png" alt="DhishaAI" style={{ height: 36, width: "auto", display: "block" }} />
        </div>
        <div className="landing-nav-links">
          <span className="landing-nav-link" onClick={() => document.getElementById("courses")?.scrollIntoView({ behavior: "smooth" })}>Courses</span>
          <span className="landing-nav-link" onClick={() => document.getElementById("features")?.scrollIntoView({ behavior: "smooth" })}>Features</span>
          <span className="landing-nav-link" onClick={() => document.getElementById("testimonials")?.scrollIntoView({ behavior: "smooth" })}>Testimonials</span>
          <span className="landing-nav-link" onClick={() => document.getElementById("contact")?.scrollIntoView({ behavior: "smooth" })}>Contact</span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn-ghost" style={{ color: "rgba(255,255,255,.8)", border: "1px solid rgba(255,255,255,.2)", borderRadius: 10 }} onClick={onGetStarted}>Login</button>
          <button className="btn btn-primary" onClick={onGetStarted}>Get Started →</button>
        </div>
      </nav>

      {/* Hero Section */}
      <div style={{ textAlign: "center", padding: "clamp(48px,8vw,90px) clamp(16px,4vw,48px) clamp(32px,5vw,64px)", maxWidth: 860, margin: "0 auto" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "rgba(232,119,34,.15)", border: "1px solid rgba(232,119,34,.3)", borderRadius: 20, padding: "6px 16px", fontSize: 13, color: B.orange, fontWeight: 600, marginBottom: 28 }}>
          <Ico n="zap" s={14} c={B.orange} /> Skills That Get You Hired
        </div>
        <h1 style={{ fontSize: "clamp(38px,5.5vw,72px)", fontWeight: 900, color: "#fff", lineHeight: 1.08, marginBottom: 22, letterSpacing: "-1px" }}>
          Master In-Demand Skills.<br />
          <span style={{ color: B.orange, textShadow: `0 0 40px ${B.orange}55` }}>Land Your Dream Job.</span>
        </h1>
        <p style={{ fontSize: "clamp(15px,1.8vw,19px)", color: "rgba(255,255,255,.68)", marginBottom: 40, maxWidth: 580, margin: "0 auto 40px", lineHeight: 1.6 }}>
          Structured courses, 24/7 AI tutoring, live coding practice, and placement support — everything you need to become a job-ready professional.
        </p>
        <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap" }}>
          <button className="btn btn-primary btn-lg" onClick={onGetStarted}>Start Learning Free</button>
          <button onClick={onGetStarted} style={{ padding: "14px 32px", borderRadius: 10, border: "2px solid rgba(255,255,255,.25)", background: "rgba(255,255,255,.06)", color: "#fff", fontWeight: 600, fontSize: 16, cursor: "pointer", transition: "all .2s", backdropFilter: "blur(8px)" }}>View Courses →</button>
        </div>

        {/* Stats bar */}
        <div style={{ display: "flex", justifyContent: "center", gap: "clamp(24px,5vw,56px)", marginTop: 48, flexWrap: "wrap", borderTop: "1px solid rgba(255,255,255,.1)", paddingTop: 36 }}>
          {stats.map(([n, l]) => (
            <div key={l} className="stat-hero">
              <div className="stat-hero-num">{n}</div>
              <div className="stat-hero-lbl">{l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Features Grid */}
      <div id="features" style={{ padding: "0 clamp(16px,4vw,48px) clamp(40px,6vw,80px)", maxWidth: 1160, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <h2 style={{ fontSize: "clamp(24px,3vw,36px)", fontWeight: 800, color: "#fff", marginBottom: 10 }}>Everything You Need to Succeed</h2>
          <p style={{ color: "rgba(255,255,255,.55)", fontSize: 16 }}>A complete learning ecosystem built for working professionals and fresh graduates</p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: 20 }}>
          {features.map(f => (
            <div key={f.title} className="feature-card">
              <div style={{ width: 46, height: 46, borderRadius: 12, background: `${B.orange}22`, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
                <Ico n={f.icon} s={22} c={B.orange} />
              </div>
              <div style={{ fontWeight: 700, color: "#fff", marginBottom: 8, fontSize: 15 }}>{f.title}</div>
              <div style={{ fontSize: 13, color: "rgba(255,255,255,.55)", lineHeight: 1.6 }}>{f.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Course Preview */}
      <div id="courses" style={{ padding: "0 clamp(16px,4vw,48px) clamp(40px,6vw,80px)", maxWidth: 1160, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <h2 style={{ fontSize: "clamp(22px,3vw,34px)", fontWeight: 800, color: "#fff", marginBottom: 10 }}>Our Courses</h2>
          <p style={{ color: "rgba(255,255,255,.55)" }}>Practical, industry-aligned curriculum taught by expert instructors</p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 20 }}>
          {courses.map(c => (
            <div key={c.title} style={{ background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)", borderRadius: 16, overflow: "hidden", transition: "transform .2s", cursor: "pointer" }} onClick={onGetStarted}>
              <div style={{ height: 80, background: `linear-gradient(135deg,${c.color},${c.color}99)`, display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
                <Ico n="book" s={36} c="rgba(255,255,255,.4)" />
                <span style={{ position: "absolute", top: 10, right: 10, background: B.orange, color: "#fff", borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 800, letterSpacing: .5 }}>{c.tag}</span>
              </div>
              <div style={{ padding: 18 }}>
                <div style={{ fontWeight: 700, color: "#fff" }}>{c.title}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Testimonials */}
      <div id="testimonials" style={{ padding: "0 clamp(16px,4vw,48px) clamp(40px,6vw,80px)", maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <h2 style={{ fontSize: "clamp(22px,3vw,34px)", fontWeight: 800, color: "#fff", marginBottom: 10 }}>What Our Students Say</h2>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 20 }}>
          {testimonials.map(t => (
            <div key={t.name} className="testimonial-card">
              <div style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 52, color: B.orange, height: 26, marginBottom: 8, lineHeight: 1, userSelect: "none" }}>&ldquo;</div>
              <p style={{ color: "rgba(255,255,255,.8)", fontSize: 14, lineHeight: 1.7, marginBottom: 18 }}>{t.text}</p>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: `${B.orange}30`, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, color: B.orange, fontSize: 16 }}>{t.avatar}</div>
                <div>
                  <div style={{ fontWeight: 700, color: "#fff", fontSize: 14 }}>{t.name}</div>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)" }}>{t.role}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* CTA Banner */}
      <div style={{ padding: "0 clamp(16px,4vw,48px) clamp(48px,6vw,80px)", maxWidth: 800, margin: "0 auto", textAlign: "center" }}>
        <div style={{ background: `linear-gradient(135deg,${B.orange}22,rgba(23,64,110,.4))`, border: `1px solid ${B.orange}44`, borderRadius: 24, padding: "clamp(32px,5vw,56px)" }}>
          <h2 style={{ fontSize: "clamp(24px,3vw,38px)", fontWeight: 900, color: "#fff", marginBottom: 14 }}>Ready to Start Your Data Career?</h2>
          <p style={{ color: "rgba(255,255,255,.65)", marginBottom: 28, fontSize: 16 }}>Join 2,000+ students who transformed their careers with DhishaAI</p>
          <button className="btn btn-primary btn-lg" onClick={onGetStarted}>Enroll Now — It's Free</button>
        </div>
      </div>

      {/* Contact Section */}
      <div id="contact" style={{ padding: "0 clamp(16px,4vw,48px) clamp(48px,6vw,80px)", maxWidth: 1000, margin: "0 auto", scrollMarginTop: 90 }}>
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <h2 style={{ fontSize: "clamp(24px,3vw,36px)", fontWeight: 800, color: "#fff", marginBottom: 10 }}>Get In Touch</h2>
          <p style={{ color: "rgba(255,255,255,.55)", fontSize: 16 }}>Have questions? Reach out to us on any of these channels — we'd love to hear from you.</p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 16 }}>
          {[
            { icon: "mail",      label: "Email",     value: "admin@dhishaai.com",           href: "mailto:admin@dhishaai.com" },
            { icon: "phone",     label: "Phone",     value: "+91 98860 90090",              href: "tel:+919886090090" },
            { icon: "globe",     label: "Website",   value: "www.dhishaai.com",             href: "https://www.dhishaai.com" },
            { icon: "instagram", label: "Instagram", value: "@dhisha_complete_analytics",   href: "https://instagram.com/dhisha_complete_analytics" },
            { icon: "linkedin",  label: "LinkedIn",  value: "DhishaAI Complete Analytics",  href: "https://www.linkedin.com/company/dhishaai-complete-analytics" },
          ].map(c => (
            <a key={c.label} href={c.href} target={c.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className="contact-card" style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 20px", borderRadius: 14, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)", textDecoration: "none", transition: "all .2s" }}>
              <div style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 12, background: `${B.orange}22`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Ico n={c.icon} s={20} c={B.orange} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,.5)", marginBottom: 3 }}>{c.label}</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.value}</div>
              </div>
            </a>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div style={{ borderTop: "1px solid rgba(255,255,255,.08)", padding: "24px clamp(16px,4vw,48px)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div style={{ color: "rgba(255,255,255,.4)", fontSize: 13 }}>© 2026 DhishaAI Complete Analytics, Bengaluru</div>
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <a href="mailto:admin@dhishaai.com" style={{ color: "rgba(255,255,255,.4)", fontSize: 13, display: "flex", alignItems: "center", gap: 5 }}><Ico n="mail" s={14} />admin@dhishaai.com</a>
          <a href="tel:+919886090090" style={{ color: "rgba(255,255,255,.4)", fontSize: 13, display: "flex", alignItems: "center", gap: 5 }}><Ico n="phone" s={14} />+91 98860 90090</a>
          <a href="https://instagram.com/dhisha_complete_analytics" target="_blank" rel="noreferrer" style={{ color: "rgba(255,255,255,.4)", display: "flex", alignItems: "center" }} aria-label="Instagram"><Ico n="instagram" s={16} /></a>
          <a href="https://www.linkedin.com/company/dhishaai-complete-analytics" target="_blank" rel="noreferrer" style={{ color: "rgba(255,255,255,.4)", display: "flex", alignItems: "center" }} aria-label="LinkedIn"><Ico n="linkedin" s={16} /></a>
        </div>
      </div>
    </div>
  );
};


// ─── AUTH PAGE ─────────────────────────────────────────────────────────────────
const AuthPage = ({ onLogin, onBack }) => {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [name, setName] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  // Message shown when a student was force-logged-out for leaving a quiz tab.
  const [lockMsg, setLockMsg] = useState("");
  useEffect(() => {
    try { const m = sessionStorage.getItem("lms_lock_msg"); if (m) { setLockMsg(m); sessionStorage.removeItem("lms_lock_msg"); } } catch (e) {}
  }, []);

  const submit = async () => {
    if (!email || !pw) { setErr("Please fill all fields"); return; }
    setErr(""); setLoading(true);
    try {
      let data;
      if (mode === "login") data = await POST("/auth/login", { email, password: pw });
      else data = await POST("/auth/register", { name, email, password: pw });
      setToken(data.token);
      onLogin(data.user, data.studentId, data.adminId, data.subject);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(150deg,#0D2137,#17406E)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div className="auth-scope" style={{ background: "#fff", borderRadius: 24, padding: "clamp(28px,4vw,44px)", width: "100%", maxWidth: 460, boxShadow: "0 20px 60px rgba(0,0,0,.25)" }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: B.gray, fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 5, marginBottom: 20, cursor: "pointer" }}>
          <Ico n="arrowL" s={14} />Back to home
        </button>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <img src="/dhishaai-logo.png" alt="DhishaAI" style={{ height: 52, width: "auto", margin: "0 auto 16px", display: "block", maxWidth: 200 }} />
          <h2 style={{ fontWeight: 800, fontSize: 22, color: B.dark }}>{mode === "login" ? "Welcome back!" : "Create account"}</h2>
          <p style={{ color: B.gray, fontSize: 14, marginTop: 4 }}>{mode === "login" ? "Sign in to continue learning" : "Start your data analytics journey"}</p>
        </div>

        {lockMsg && (
          <div style={{ background: "#FEE2E2", border: "1px solid #FCA5A5", color: "#B91C1C", borderRadius: 12, padding: "12px 14px", fontSize: 13, fontWeight: 600, marginBottom: 20, display: "flex", alignItems: "flex-start", gap: 8 }}>
            <Ico n="lock" s={16} c="#B91C1C" /><span>{lockMsg}</span>
          </div>
        )}

        <div className="tab-bar" style={{ marginBottom: 24 }}>
          <button className={`tab ${mode === "login" ? "active" : ""}`} onClick={() => { setMode("login"); setErr(""); }} style={{ flex: 1, justifyContent: "center" }}>Login</button>
          <button className={`tab ${mode === "register" ? "active" : ""}`} onClick={() => { setMode("register"); setErr(""); }} style={{ flex: 1, justifyContent: "center" }}>Register</button>
        </div>

        {mode === "register" && (
          <div className="form-group">
            <label className="form-label">Full Name</label>
            <input className="input-field" placeholder="Rahul Sharma" value={name} onChange={e => setName(e.target.value)} />
          </div>
        )}
        <div className="form-group">
          <label className="form-label">Email Address</label>
          <input className="input-field" type="email" placeholder="you@email.com" value={email} onChange={e => setEmail(e.target.value)} />
        </div>
        <div className="form-group" style={{ marginBottom: 20 }}>
          <label className="form-label">Password</label>
          <div style={{ position: "relative" }}>
            <input className="input-field" type={showPw ? "text" : "password"} placeholder="••••••••" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()} style={{ paddingRight: 44 }} />
            <button onClick={() => setShowPw(v => !v)} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: B.gray, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
              {showPw ? "HIDE" : "SHOW"}
            </button>
          </div>
        </div>

        {err && <div style={{ background: "#FEE2E2", color: B.danger, padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 14, fontWeight: 500 }}>{err}</div>}
        <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", padding: "13px" }} onClick={submit} disabled={loading}>
          {loading ? <Spinner size={18} color="#fff" /> : (mode === "login" ? "Sign In →" : "Create Account →")}
        </button>
      </div>
    </div>
  );
};

// ─── ADMIN DASHBOARD ──────────────────────────────────────────────────────────
const AdminDashboard = () => {
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { GET("/analytics/overview").then(setAnalytics).catch(() => {}).finally(() => setLoading(false)); }, []);

  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={36} /></div>;
  if (!analytics) return <EmptyState icon="chart" title="No data yet" desc="Analytics will appear once students start learning." />;

  return (
    <div className="fadeIn">
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: "var(--text)" }}>Dashboard</h1>
        <p style={{ color: "var(--text2)", fontSize: 13, marginTop: 3 }}>Overview of your enrolled students</p>
      </div>
      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <StatCard label="Total Students" value={analytics.totalStudents} icon="users" color={B.navy} />
        <StatCard label="Active Courses" value={analytics.totalCourses} icon="book" color="#4F46E5" />
        <StatCard label="Quizzes" value={analytics.totalQuizzes} icon="quiz" color={B.orange} />
        <StatCard label="Quiz Attempts" value={analytics.totalAttempts} icon="chart" color="#10B981" />
        <StatCard label="Avg Score" value={`${analytics.avgScore}%`} icon="star" color="#F59E0B" />
        <StatCard label="Active Learners" value={analytics.activeStudents} icon="flame" color="#EF4444" />
      </div>
      <div className="mobile-stack" style={{ marginBottom: 24 }}>
        <div className="card-flat" style={{ padding: 20 }}>
          <h3 style={{ fontWeight: 700, marginBottom: 16, color: "var(--text)", fontSize: 15 }}>Students by Batch</h3>
          {analytics.enrollmentsByBatch.map(b => (
            <div key={b.batch} style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
                <span style={{ fontWeight: 500, color: "var(--text)" }}>{b.batch}</span>
                <span style={{ fontWeight: 700, color: B.orange }}>{b.count}</span>
              </div>
              <ProgressBar value={(b.count / Math.max(1, analytics.totalStudents)) * 100} height={6} />
            </div>
          ))}
        </div>
        <div className="card-flat" style={{ padding: 20 }}>
          <h3 style={{ fontWeight: 700, marginBottom: 16, color: "var(--text)", fontSize: 15 }}>Top Learners</h3>
          {analytics.progressByStudent.sort((a, b) => b.xp - a.xp).slice(0, 5).map((s, i) => (
            <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <div style={{ width: 30, height: 30, borderRadius: 8, background: i === 0 ? "#F59E0B" : i === 1 ? "#94A3B8" : i === 2 ? "#CD7C2F" : "var(--surface2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, color: i < 3 ? "#fff" : "var(--text2)" }}>
                {i < 3 ? ["🥇", "🥈", "🥉"][i] : i + 1}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{s.name}</div>
                <div style={{ fontSize: 11, color: "var(--text2)" }}>{Math.round(s.progress)}% avg</div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: B.orange }}>{s.xp.toLocaleString()} XP</div>
            </div>
          ))}
        </div>
      </div>
      {analytics.quizResults.length > 0 && (
        <div className="card-flat" style={{ padding: 24, overflow: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h3 style={{ fontWeight: 700, color: "var(--text)", fontSize: 15 }}>Recent Quiz Attempts</h3>
            <span className="badge badge-navy">{analytics.quizResults.length} total</span>
          </div>
          <table className="data-table">
            <thead><tr><th>Student</th><th>Score</th><th>Date</th></tr></thead>
            <tbody>
              {analytics.quizResults.slice(-8).reverse().map(r => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 500 }}>Student #{r.studentId}</td>
                  <td><span className={`badge ${r.score / r.total >= .7 ? "badge-green" : "badge-red"}`}>{r.score}/{r.total} ({Math.round(r.score / r.total * 100)}%)</span></td>
                  <td style={{ color: "var(--text2)", fontSize: 12 }}>{new Date(r.completedAt).toLocaleDateString("en-IN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ─── ADMIN STUDENTS ────────────────────────────────────────────────────────────
const AdminStudentsPage = ({ batches, courses }) => {
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [search, setSearch] = useState("");
  const [batchFilter, setBatchFilter] = useState(""); // "" = all batches
  const [show, toastEl] = useToast();
  const [form, setForm] = useState({ name: "", email: "", phone: "", password: "student123", batchId: "", enrolledCourses: [], experience: "", company: "", qualification: "" });
  // Batches are managed locally so a batch created inline shows up immediately.
  const [batchList, setBatchList] = useState(batches || []);
  const [creatingBatch, setCreatingBatch] = useState(false);
  const [newBatchName, setNewBatchName] = useState("");

  // Pending enrollment requests from students, and the batch chosen per request.
  const [requests, setRequests] = useState([]);
  const [reqBatch, setReqBatch] = useState({});   // { [reqId]: batchId | "__new__" }
  const [reqNewBatch, setReqNewBatch] = useState({}); // { [reqId]: typed name while creating }

  const load = () => GET("/students").then(setStudents).finally(() => setLoading(false));
  const reloadBatches = () => GET("/batches").then(setBatchList).catch(() => {});
  const loadRequests = () => GET("/enroll-requests").then(setRequests).catch(() => {});
  useEffect(() => { load(); reloadBatches(); loadRequests(); }, []);

  const approveReq = async (r) => {
    const chosen = reqBatch[r.id] ?? r.batchId ?? "";
    if (chosen === "__new__") { show("Create the batch (or pick one) before approving", "error"); return; }
    try {
      await POST(`/enroll-requests/${r.id}/approve`, { batchId: chosen || "" });
      show(`Approved — ${r.studentName} enrolled in ${r.courseTitle}`);
      loadRequests(); load();
    } catch (e) { show(e.message, "error"); }
  };
  // Create a batch inline while approving a request, and select it for that request.
  const createBatchForReq = async (r) => {
    const name = (reqNewBatch[r.id] || "").trim();
    if (!name) { show("Enter a batch name", "error"); return; }
    try {
      const b = await POST("/batches", { name });
      await reloadBatches();
      setReqBatch(m => ({ ...m, [r.id]: b.id }));
      setReqNewBatch(m => ({ ...m, [r.id]: "" }));
      show(`Batch "${b.name}" created — ${r.studentName} will be added to it`);
    } catch (e) { show(e.message, "error"); }
  };
  const rejectReq = async (r) => {
    if (!confirm(`Reject ${r.studentName}'s request for "${r.courseTitle}"?`)) return;
    try { await POST(`/enroll-requests/${r.id}/reject`, {}); show("Request rejected"); loadRequests(); }
    catch (e) { show(e.message, "error"); }
  };

  const batchName = id => batchList.find(b => b.id === id)?.name || id || "—";
  const createBatch = async () => {
    const name = newBatchName.trim();
    if (!name) { show("Enter a batch name", "error"); return; }
    try {
      const b = await POST("/batches", { name });
      await reloadBatches();
      setForm(f => ({ ...f, batchId: b.id }));
      setCreatingBatch(false); setNewBatchName("");
      show(`Batch "${b.name}" created`);
    } catch (e) { show(e.message, "error"); }
  };

  const openAdd = () => { setForm({ name: "", email: "", phone: "", password: "student123", batchId: "", enrolledCourses: [], experience: "", company: "", qualification: "" }); setModal("add"); };
  const openEdit = s => { setForm({ name: s.name, email: s.email, phone: s.phone || "", password: "", batchId: s.batchId, enrolledCourses: s.enrolledCourses || [], experience: s.experience || "", company: s.company || "", qualification: s.qualification || "" }); setModal(s); };

  const save = async () => {
    try {
      if (modal === "add") await POST("/students", form);
      else await PUT(`/students/${modal.id}`, form);
      show("Saved successfully"); setModal(null); load();
    } catch (e) { show(e.message, "error"); }
  };

  const del = async id => {
    if (!confirm("Delete this student? This cannot be undone.")) return;
    try { await DELETE(`/students/${id}`); show("Student removed"); load(); }
    catch (e) { show(e.message, "error"); }
  };

  const toggleCourse = cid => setForm(f => ({ ...f, enrolledCourses: f.enrolledCourses.includes(cid) ? f.enrolledCourses.filter(c => c !== cid) : [...f.enrolledCourses, cid] }));
  const filtered = students.filter(s =>
    (s.name.toLowerCase().includes(search.toLowerCase()) || s.email.toLowerCase().includes(search.toLowerCase())) &&
    (batchFilter === "" || String(s.batchId || "") === batchFilter));

  return (
    <div className="fadeIn">
      {toastEl}
      <div className="section-header">
        <div>
          <h1 className="section-title">My Students</h1>
          <p style={{ color: "var(--text2)", fontSize: 13, marginTop: 2 }}>{students.length} students enrolled</p>
        </div>
        <button className="btn btn-primary" onClick={openAdd}><Ico n="plus" s={15} />Add Student</button>
      </div>

      {requests.length > 0 && (
        <div className="card-flat" style={{ padding: 20, marginBottom: 16, borderLeft: `3px solid ${B.orange}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <Ico n="bell" s={16} c={B.orange} />
            <h3 style={{ fontWeight: 700, fontSize: 15, color: "var(--text)" }}>Enrollment Requests</h3>
            <span className="badge" style={{ background: `${B.orange}20`, color: B.orange }}>{requests.length}</span>
          </div>
          <p style={{ color: "var(--text2)", fontSize: 12.5, marginBottom: 14 }}>Students asking to join a course. Approve (and pick their batch) or reject.</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {requests.map(r => (
              <div key={r.id} style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, justifyContent: "space-between" }}>
                <div style={{ minWidth: 180 }}>
                  <div style={{ fontWeight: 700, color: "var(--text)", fontSize: 14 }}>{r.studentName}</div>
                  <div style={{ fontSize: 12, color: "var(--text2)" }}>wants to join <b style={{ color: "var(--text)" }}>{r.courseTitle}</b></div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  {reqBatch[r.id] === "__new__" ? (
                    <>
                      <input className="input-field" style={{ padding: "7px 10px", fontSize: 13, minWidth: 150 }}
                        placeholder="New batch name" autoFocus value={reqNewBatch[r.id] || ""}
                        onChange={e => setReqNewBatch(m => ({ ...m, [r.id]: e.target.value }))}
                        onKeyDown={e => { if (e.key === "Enter") createBatchForReq(r); if (e.key === "Escape") setReqBatch(m => ({ ...m, [r.id]: "" })); }} />
                      <button className="btn btn-primary btn-sm" onClick={() => createBatchForReq(r)}><Ico n="check" s={13} />Create batch</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => { setReqBatch(m => ({ ...m, [r.id]: "" })); setReqNewBatch(m => ({ ...m, [r.id]: "" })); }}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <select className="input-field" style={{ padding: "7px 10px", fontSize: 13, minWidth: 150 }}
                        value={reqBatch[r.id] ?? r.batchId ?? ""} onChange={e => setReqBatch(m => ({ ...m, [r.id]: e.target.value }))}>
                        <option value="">No batch</option>
                        {batchList.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                        <option value="__new__">+ Create new batch…</option>
                      </select>
                      <button className="btn btn-primary btn-sm" onClick={() => approveReq(r)}><Ico n="check" s={13} />Approve</button>
                      <button className="btn btn-danger btn-sm" onClick={() => rejectReq(r)}><Ico n="x" s={13} />Reject</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card-flat" style={{ padding: 14, marginBottom: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 180, display: "flex", alignItems: "center", gap: 8, background: "var(--surface2)", borderRadius: 9, padding: "8px 12px", border: "1px solid var(--border)" }}>
          <Ico n="search" s={15} c="var(--text2)" />
          <input style={{ background: "none", border: "none", fontSize: 14, color: "var(--text)", flex: 1, outline: "none" }} placeholder="Search students..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="input-field" value={batchFilter} onChange={e => setBatchFilter(e.target.value)} style={{ width: "auto", minWidth: 170, flexShrink: 0 }}>
          <option value="">All batches</option>
          {batchList.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        {batchFilter && <span className="badge badge-navy" style={{ alignSelf: "center" }}>{filtered.length} in {batchName(batchFilter)}</span>}
      </div>
      <div className="card-flat" style={{ overflow: "auto" }}>
        {loading ? <div style={{ padding: 40, textAlign: "center" }}><Spinner size={32} /></div> : filtered.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--text2)" }}>
            {search ? "No students match your search" : "No students yet — add one!"}
          </div>
        ) : (
          <table className="data-table">
            <thead><tr><th>Student</th><th>Batch</th><th>Courses</th><th>XP</th><th>Streak</th><th>Actions</th></tr></thead>
            <tbody>
              {filtered.map(s => (
                <tr key={s.id}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ width: 34, height: 34, borderRadius: 9, background: `${B.navy}18`, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, color: B.navy, fontSize: 14, flexShrink: 0 }}>{s.name[0]}</div>
                      <div>
                        <div style={{ fontWeight: 600, color: "var(--text)" }}>{s.name}</div>
                        <div style={{ fontSize: 12, color: "var(--text2)" }}>{s.email}</div>
                      </div>
                    </div>
                  </td>
                  <td><span className="badge badge-navy">{batchName(s.batchId)}</span></td>
                  <td><span className="badge badge-orange">{(s.enrolledCourses || []).length} courses</span></td>
                  <td style={{ fontWeight: 700, color: B.orange }}>{s.xp?.toLocaleString()}</td>
                  <td style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13, color: "var(--text)" }}><Ico n="flame" s={13} c="#F97316" />{s.streak}d</td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className="btn btn-secondary btn-xs" onClick={() => openEdit(s)}><Ico n="edit" s={12} />Edit</button>
                      <button className="btn btn-danger btn-xs" onClick={() => del(s.id)}><Ico n="trash" s={12} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {modal && (
        <Modal title={modal === "add" ? "Add Student" : "Edit Student"} onClose={() => setModal(null)}>
          <div className="form-group"><label className="form-label">Full Name</label><input className="input-field" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
          <div className="form-group"><label className="form-label">Email</label><input className="input-field" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} disabled={modal !== "add"} /></div>
          <div className="form-group"><label className="form-label">Phone (optional)</label><input className="input-field" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="form-group"><label className="form-label">Qualification</label><input className="input-field" placeholder="e.g. B.Tech CSE" value={form.qualification} onChange={e => setForm({ ...form, qualification: e.target.value })} /></div>
            <div className="form-group"><label className="form-label">Experience</label><input className="input-field" placeholder="e.g. 2 years / Fresher" value={form.experience} onChange={e => setForm({ ...form, experience: e.target.value })} /></div>
          </div>
          <div className="form-group"><label className="form-label">Company (optional)</label><input className="input-field" placeholder="Current / previous company" value={form.company} onChange={e => setForm({ ...form, company: e.target.value })} /></div>
          {modal === "add" && <div className="form-group"><label className="form-label">Password</label><input className="input-field" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></div>}
          <div className="form-group">
            <label className="form-label">Batch <span style={{ color: "var(--text2)", fontWeight: 500 }}>(the joining group this student belongs to)</span></label>
            {!creatingBatch ? (
              <div style={{ display: "flex", gap: 8 }}>
                <select className="input-field" style={{ flex: 1 }} value={form.batchId} onChange={e => setForm({ ...form, batchId: e.target.value })}>
                  <option value="">No batch</option>
                  {batchList.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                <button type="button" className="btn btn-secondary" onClick={() => setCreatingBatch(true)}><Ico n="plus" s={14} />New batch</button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8 }}>
                <input className="input-field" style={{ flex: 1 }} placeholder="e.g. Batch Jul 2026" value={newBatchName} autoFocus
                  onChange={e => setNewBatchName(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); createBatch(); } }} />
                <button type="button" className="btn btn-primary" onClick={createBatch}>Create</button>
                <button type="button" className="btn btn-secondary" onClick={() => { setCreatingBatch(false); setNewBatchName(""); }}>Cancel</button>
              </div>
            )}
          </div>
          <div className="form-group">
            <label className="form-label">Enrolled Courses</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
              {courses.map(c => (
                <button key={c.id} type="button" onClick={() => toggleCourse(c.id)} style={{ padding: "6px 14px", borderRadius: 20, fontSize: 13, fontWeight: 600, background: form.enrolledCourses.includes(c.id) ? B.orange : "var(--surface2)", color: form.enrolledCourses.includes(c.id) ? "#fff" : "var(--text)", border: `1.5px solid ${form.enrolledCourses.includes(c.id) ? B.orange : "var(--border)"}`, cursor: "pointer", transition: "all .15s" }}>{c.title}</button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <button className="btn btn-primary" style={{ flex: 1, justifyContent: "center" }} onClick={save}>Save Student</button>
            <button className="btn btn-secondary" onClick={() => setModal(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
};

// ─── SHARED: MODULE / TOPIC MODEL ──────────────────────────────────────────────
// Per-subject topic content for the guided learning flow (used by student course
// view AND the admin quiz creator so quizzes can be tied to real module topics).
const TOPIC_SETS = {
  Python: [
    { title: "Introduction & Setup", duration: "12 min" },
    { title: "Variables & Data Types", duration: "18 min" },
    { title: "Operators & Expressions", duration: "20 min" },
    { title: "Control Flow — if / elif / else", duration: "25 min" },
    { title: "Loops — for & while", duration: "22 min" },
    { title: "Functions & Lambda", duration: "30 min" },
    { title: "Lists, Tuples, Dicts & Sets", duration: "28 min" },
    { title: "Mini Project", duration: "45 min" },
  ],
  SQL: [
    { title: "Databases & Tables", duration: "15 min" },
    { title: "SELECT & Filtering (WHERE)", duration: "20 min" },
    { title: "Sorting & Limiting Results", duration: "16 min" },
    { title: "JOINs Explained", duration: "26 min" },
    { title: "Aggregations & GROUP BY", duration: "22 min" },
    { title: "Subqueries & CTEs", duration: "24 min" },
  ],
  BI: [
    // Module 1 — Introduction to Power BI (Session 1)
    { title: "What is Power BI — Purpose & Why", duration: "15 min" },
    { title: "Architecture & Core Components", duration: "18 min" },
    { title: "Editions, Licensing & Versions", duration: "20 min" },
    // Module 2 — Building with Power BI
    { title: "Power Query & Data Transformation", duration: "25 min" },
    { title: "Data Modeling & DAX", duration: "30 min" },
    { title: "Dashboards, Reports & Publishing", duration: "28 min" },
  ],
  ML: [
    { title: "What is Machine Learning?", duration: "15 min" },
    { title: "Supervised vs Unsupervised", duration: "20 min" },
    { title: "Linear Regression", duration: "28 min" },
    { title: "Classification Models", duration: "30 min" },
    { title: "Model Evaluation Metrics", duration: "25 min" },
    { title: "Overfitting & Tuning", duration: "22 min" },
  ],
  Excel: [
    { title: "Excel Interface & Basics", duration: "12 min" },
    { title: "Formulas & Functions", duration: "20 min" },
    { title: "VLOOKUP & XLOOKUP", duration: "22 min" },
    { title: "Pivot Tables", duration: "25 min" },
    { title: "Charts & Visualization", duration: "20 min" },
    { title: "Building Excel Dashboards", duration: "25 min" },
  ],
};
const DEFAULT_TOPICS = [
  { title: "Getting Started", duration: "15 min" },
  { title: "Core Concepts", duration: "20 min" },
  { title: "Hands-on Practice", duration: "25 min" },
  { title: "Intermediate Techniques", duration: "22 min" },
  { title: "Real-world Application", duration: "28 min" },
  { title: "Wrap-up & Review", duration: "15 min" },
];
const TOPICS_PER_MODULE = 3;

// Module list for a course. Prefers ADMIN-AUTHORED modules (course.modules); if the
// admin hasn't created any yet, falls back to the built-in per-subject topic outline.
function courseModules(course) {
  if (course && Array.isArray(course.modules) && course.modules.length) {
    return course.modules.map((m, i) => ({
      index: i,
      title: m.title || `Module ${i + 1}`,
      topics: (m.topics || []).map(t => (typeof t === "string" ? { title: t, duration: "" } : t)),
    }));
  }
  const topics = (course && (TOPIC_SETS[course.category] || DEFAULT_TOPICS)) || DEFAULT_TOPICS;
  const mods = [];
  for (let i = 0; i < topics.length; i += TOPICS_PER_MODULE) {
    mods.push({ index: mods.length, title: `Module ${mods.length + 1}`, topics: topics.slice(i, i + TOPICS_PER_MODULE) });
  }
  return mods;
}

// Build the student-facing module list: attach the matching quiz + global topic indexes.
// A quiz tagged with moduleIndex binds to that exact module; legacy/untagged quizzes fall back to order.
function buildModules(course, quizzes) {
  const mods = courseModules(course);
  const courseQuizzes = quizzes.filter(q => q.courseId === course.id);
  const untagged = courseQuizzes.filter(q => q.moduleIndex === undefined || q.moduleIndex === null);
  let gi = 0;
  const modules = mods.map(m => {
    const topics = m.topics.map(t => ({ ...t, globalIndex: gi++ }));
    const quiz = courseQuizzes.find(q => q.moduleIndex === m.index) || untagged[m.index] || null;
    return { index: m.index, title: m.title, topics, quiz };
  });
  return { modules, totalTopics: gi };
}

// ─── ADMIN COURSES ─────────────────────────────────────────────────────────────
// ─── COURSE TOPICS MODAL ─────────────────────────────────────────────────────
// Admin manages the ordered lesson/topic list for a course. Students see this
// same list (fetched live) on the course detail page.
const CourseTopicsModal = ({ course, onClose }) => {
  const [topics, setTopics] = useState([]);
  const [show, toastEl] = useToast();
  const [form, setForm] = useState({ title: "", duration: "" });
  const [insertAfterOrder, setInsertAfterOrder] = useState(""); // "" = add to end
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ title: "", duration: "" });

  const load = () => GET(`/courses/${course.id}/topics`).then(setTopics).catch(() => {});
  useEffect(() => { load(); }, []);

  const addTopic = async () => {
    if (!form.title.trim()) return show("Title required", "error");
    try {
      await POST(`/courses/${course.id}/topics`, { ...form, insertAfterOrder: insertAfterOrder === "" ? null : Number(insertAfterOrder) });
      setForm({ title: "", duration: "" });
      setInsertAfterOrder("");
      load(); show("Topic added!");
    } catch (e) { show(e.message, "error"); }
  };

  const saveTopic = async (t) => {
    try {
      await PUT(`/courses/${course.id}/topics/${t.id}`, editForm);
      setEditingId(null); load(); show("Saved!");
    } catch (e) { show(e.message, "error"); }
  };

  const deleteTopic = async (t) => {
    if (!confirm(`Delete "${t.title}"?`)) return;
    try { await DELETE(`/courses/${course.id}/topics/${t.id}`); load(); show("Deleted"); }
    catch (e) { show(e.message, "error"); }
  };

  const moveUp = async (t, i) => {
    if (i === 0) return;
    const prev = topics[i - 1];
    await PUT(`/courses/${course.id}/topics/${t.id}`, { order: prev.order });
    await PUT(`/courses/${course.id}/topics/${prev.id}`, { order: t.order });
    load();
  };

  const moveDown = async (t, i) => {
    if (i === topics.length - 1) return;
    const next = topics[i + 1];
    await PUT(`/courses/${course.id}/topics/${t.id}`, { order: next.order });
    await PUT(`/courses/${course.id}/topics/${next.id}`, { order: t.order });
    load();
  };

  return (
    <Modal title={`Manage Topics — ${course.title}`} onClose={onClose} wide>
      {toastEl}
      {/* Topic list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
        {topics.length === 0 && <p style={{ color: "var(--text2)", fontSize: 13 }}>No topics yet — add the first one below.</p>}
        {topics.map((t, i) => (
          <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--surface2)", borderRadius: 10, padding: 12, border: "1px solid var(--border)" }}>
            <span style={{ fontWeight: 700, color: "var(--text2)", fontSize: 13, flexShrink: 0 }}>{i + 1}.</span>
            {editingId === t.id ? (
              <>
                <input className="input-field" style={{ flex: 1, minWidth: 120 }} value={editForm.title} onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))} />
                <input className="input-field" style={{ width: 110 }} value={editForm.duration} onChange={e => setEditForm(f => ({ ...f, duration: e.target.value }))} placeholder="Duration" />
                <button className="btn btn-primary btn-sm" onClick={() => saveTopic(t)}>Save</button>
                <button className="btn btn-secondary btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
              </>
            ) : (
              <>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)" }}>{t.title}</div>
                  {t.duration && <div style={{ fontSize: 12, color: "var(--text2)" }}>{t.duration}</div>}
                </div>
                <button className="btn btn-secondary btn-xs" onClick={() => { setEditingId(t.id); setEditForm({ title: t.title, duration: t.duration || "" }); }}>Edit</button>
                <button className="btn btn-secondary btn-xs" onClick={() => moveUp(t, i)} disabled={i === 0}>↑</button>
                <button className="btn btn-secondary btn-xs" onClick={() => moveDown(t, i)} disabled={i === topics.length - 1}>↓</button>
                <button className="btn btn-danger btn-xs" onClick={() => deleteTopic(t)}><Ico n="trash" s={12} /></button>
              </>
            )}
          </div>
        ))}
      </div>

      {/* Add new topic */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)", marginBottom: 10 }}>Add Topic</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          <input className="input-field" style={{ flex: 1, minWidth: 180 }} placeholder="Topic title" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
          <input className="input-field" style={{ width: 110 }} placeholder="Duration" value={form.duration} onChange={e => setForm(f => ({ ...f, duration: e.target.value }))} />
        </div>
        {topics.length > 0 && (
          <div className="form-group" style={{ marginBottom: 8 }}>
            <label className="form-label" style={{ fontSize: 12 }}>Insert position</label>
            <select className="input-field" value={insertAfterOrder} onChange={e => setInsertAfterOrder(e.target.value)}>
              <option value="">Add to end</option>
              {topics.map((t, i) => (
                <option key={t.id} value={t.order}>After "{t.title}" (position {i + 2})</option>
              ))}
            </select>
          </div>
        )}
        <button className="btn btn-primary" onClick={addTopic}><Ico n="plus" s={14} />Add Topic</button>
      </div>
    </Modal>
  );
};

const AdminCoursesPage = ({ user, onCourseChange }) => {
  const isSuper = user?.role === "superadmin";
  const [courses, setCourses] = useState([]);
  const [admins, setAdmins] = useState([]);
  const [modal, setModal] = useState(null);
  const [topicsModal, setTopicsModal] = useState(null); // holds the course object
  const [show, toastEl] = useToast();
  const [form, setForm] = useState({ title: "", category: "Python", lessons: 0, duration: "", description: "", color: "#4F46E5", ownerId: "" });
  const COLORS = ["#4F46E5", "#0EA5E9", "#F59E0B", "#10B981", "#EC4899", "#EF4444", "#8B5CF6", "#E87722"];

  const load = () => GET("/courses").then(setCourses);
  useEffect(() => { load(); if (isSuper) GET("/super/admins").then(setAdmins).catch(() => {}); }, []);
  const adminName = id => admins.find(a => a.id === id)?.name || "Unassigned";

  const openAdd = () => { setForm({ title: "", category: "Python", lessons: 0, duration: "", description: "", color: "#4F46E5", ownerId: "" }); setModal("add"); };
  const openEdit = c => { setForm({ ...c, ownerId: c.ownerId || "" }); setModal(c); };

  const save = async () => {
    if (!form.title.trim()) { show("Enter a course title", "error"); return; }
    try {
      const payload = { ...form };
      if (isSuper) payload.ownerId = form.ownerId || null; else delete payload.ownerId;
      if (modal === "add") await POST("/courses", payload);
      else await PUT(`/courses/${modal.id}`, payload);
      show("Course saved!"); setModal(null); load(); onCourseChange?.();
    } catch (e) { show(e.message, "error"); }
  };

  const toggle = async (course, field) => {
    try { await PUT(`/courses/${course.id}`, { ...course, [field]: !course[field] }); load(); onCourseChange?.(); }
    catch (e) { show(e.message, "error"); }
  };

  const del = async id => {
    if (!confirm("Delete this course?")) return;
    try { await DELETE(`/courses/${id}`); show("Deleted"); load(); onCourseChange?.(); }
    catch (e) { show(e.message, "error"); }
  };

  // ── Admin-authored modules ──
  const [modCourse, setModCourse] = useState(null);
  const [modForm, setModForm] = useState({ index: null, title: "", topics: "", insertAt: "" });
  const openModules = c => { setModCourse(c); setModForm({ index: null, title: "", topics: "", insertAt: "" }); };
  const reloadModCourse = async () => {
    const list = await GET("/courses"); setCourses(list);
    setModCourse(mc => (mc ? list.find(c => c.id === mc.id) || null : null));
  };
  const saveModule = async () => {
    if (!modForm.title.trim()) { show("Enter a module title", "error"); return; }
    const topics = modForm.topics.split("\n").map(t => t.trim()).filter(Boolean);
    try {
      if (modForm.index == null) await POST(`/courses/${modCourse.id}/modules`, { title: modForm.title, topics, insertAt: modForm.insertAt === "" ? null : Number(modForm.insertAt) - 1 });
      else await PUT(`/courses/${modCourse.id}/modules/${modForm.index}`, { title: modForm.title, topics });
      setModForm({ index: null, title: "", topics: "", insertAt: "" }); await reloadModCourse(); onCourseChange?.(); show("Module saved");
    } catch (e) { show(e.message, "error"); }
  };
  const editModule = (m, i) => setModForm({ index: i, title: m.title, topics: (m.topics || []).join("\n"), insertAt: "" });
  const deleteModule = async i => {
    if (!confirm("Delete this module? Its attached notes/quiz will be unlinked.")) return;
    try { await DELETE(`/courses/${modCourse.id}/modules/${i}`); await reloadModCourse(); onCourseChange?.(); show("Module removed"); }
    catch (e) { show(e.message, "error"); }
  };
  // Admin-controlled lesson release (which modules students can open).
  const setManualRelease = async on => {
    try { await PUT(`/courses/${modCourse.id}/lesson-release`, { manualRelease: on }); await reloadModCourse(); onCourseChange?.(); show(on ? "You now control which lessons students see" : "Auto-unlock restored"); }
    catch (e) { show(e.message, "error"); }
  };
  const toggleReleased = async i => {
    const cur = Array.isArray(modCourse.releasedModules) ? modCourse.releasedModules : [];
    const next = cur.includes(i) ? cur.filter(x => x !== i) : [...cur, i];
    try { await PUT(`/courses/${modCourse.id}/lesson-release`, { releasedModules: next }); await reloadModCourse(); onCourseChange?.(); }
    catch (e) { show(e.message, "error"); }
  };

  return (
    <div className="fadeIn">
      {toastEl}
      <div className="section-header">
        <div><h1 className="section-title">My Courses</h1><p style={{ color: "var(--text2)", fontSize: 13 }}>{courses.length} courses</p></div>
        <button className="btn btn-primary" onClick={openAdd}><Ico n="plus" s={15} />Add Course</button>
      </div>
      {courses.length === 0 ? <EmptyState icon="book" title="No courses yet" desc="Create your first course to get started." action={<button className="btn btn-primary" onClick={openAdd}>Create Course</button>} /> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 20 }}>
          {courses.map(c => (
            <div key={c.id} className="card" style={{ padding: 24 }}>
              <div style={{ display: "flex", gap: 14, marginBottom: 16 }}>
                <div style={{ width: 50, height: 50, borderRadius: 12, background: c.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Ico n="book" s={24} c="#fff" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text)" }}>{c.title}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                    <span className="badge badge-navy">{c.category}</span>
                    {isSuper && <span className="badge" style={{ background: c.ownerId ? "#FFF0E5" : "#FEE2E2", color: c.ownerId ? B.orange : B.danger }}>👤 {adminName(c.ownerId)}</span>}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 13, color: "var(--text2)" }}>Syllabus Visible</span>
                  <Toggle checked={c.syllabusUnlocked} onChange={() => toggle(c, "syllabusUnlocked")} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 13, color: "var(--text2)" }}>Quiz Enabled</span>
                  <Toggle checked={c.quizEnabled} onChange={() => toggle(c, "quizEnabled")} />
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <button className="btn btn-outline btn-sm" style={{ justifyContent: "center" }} onClick={() => openModules(c)}><Ico n="book" s={14} />Manage Modules ({(c.modules || []).length})</button>
                <button className="btn btn-outline btn-sm" style={{ justifyContent: "center" }} onClick={() => setTopicsModal(c)}><Ico n="assign" s={14} />Manage Topics</button>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-secondary btn-sm" style={{ flex: 1, justifyContent: "center" }} onClick={() => openEdit(c)}><Ico n="edit" s={14} />Edit</button>
                  <button className="btn btn-danger btn-sm" onClick={() => del(c.id)}><Ico n="trash" s={14} /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {modCourse && (
        <Modal title={`Modules — ${modCourse.title}`} onClose={() => { setModCourse(null); setModForm({ index: null, title: "", topics: "", insertAt: "" }); }} wide>
          <p style={{ color: "var(--text2)", fontSize: 13, marginBottom: 12 }}>Add modules one by one. By default each module unlocks the next after its quiz is passed (70%+).</p>

          {/* Admin-controlled lesson release */}
          <div style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 12, padding: 14, marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 13.5, color: "var(--text)" }}>I control which lessons students see</div>
                <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 2 }}>Turn on to release lessons at your teaching pace — students only see the ones you release (you can skip around, e.g. release 1 and 4).</div>
              </div>
              <Toggle checked={!!modCourse.manualRelease} onChange={v => setManualRelease(v)} />
            </div>
          </div>

          {(modCourse.modules || []).length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--text2)", marginBottom: 16 }}>No modules yet — add the first one below.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
              {(modCourse.modules || []).map((m, i) => (
                <div key={i} style={{ background: "var(--surface2)", borderRadius: 10, padding: 12, border: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: "var(--text)", fontSize: 14 }}>Module {i + 1}: {m.title}</div>
                    <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 2 }}>{(m.topics || []).length} topics{(m.topics || []).length ? " — " + (m.topics || []).join(", ") : ""}</div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
                    {modCourse.manualRelease && (
                      <button type="button" onClick={() => toggleReleased(i)}
                        style={{ padding: "5px 11px", borderRadius: 20, fontSize: 12, fontWeight: 700, cursor: "pointer",
                          border: `1.5px solid ${(modCourse.releasedModules || []).includes(i) ? B.success : "var(--border)"}`,
                          background: (modCourse.releasedModules || []).includes(i) ? `${B.success}18` : "var(--surface)",
                          color: (modCourse.releasedModules || []).includes(i) ? B.success : "var(--text2)" }}>
                        {(modCourse.releasedModules || []).includes(i) ? "✓ Released" : "Locked"}
                      </button>
                    )}
                    <button className="btn btn-secondary btn-xs" onClick={() => editModule(m, i)}>Edit</button>
                    <button className="btn btn-danger btn-xs" onClick={() => deleteModule(i)}><Ico n="trash" s={12} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div style={{ background: "var(--surface2)", borderRadius: 12, padding: 16, border: "1px solid var(--border)" }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)", marginBottom: 10 }}>{modForm.index == null ? "Add Module" : `Edit Module ${modForm.index + 1}`}</div>
            {modForm.index == null && (modCourse.modules || []).length > 0 && (() => {
              const total = (modCourse.modules || []).length;
              const typed = modForm.insertAt === "" ? null : Number(modForm.insertAt);
              const willBe = typed == null ? total + 1 : Math.min(Math.max(1, typed), total + 1);
              return (
                <div className="form-group">
                  <label className="form-label">Module number <span style={{ color: "var(--text2)", fontWeight: 500 }}>(type 1–{total + 1}; leave blank to add at the end)</span></label>
                  <input className="input-field" type="number" min="1" max={total + 1}
                    placeholder={`e.g. ${total + 1}  (end)`}
                    value={modForm.insertAt}
                    onChange={e => setModForm(f => ({ ...f, insertAt: e.target.value }))} />
                  <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 6 }}>
                    {typed == null
                      ? `Will be added as Module ${total + 1} (at the end).`
                      : `Will become Module ${willBe}${willBe <= total ? " — the current modules from here shift down one." : " (at the end)."}`}
                  </div>
                </div>
              );
            })()}
            <div className="form-group"><label className="form-label">Module Title</label><input className="input-field" placeholder="e.g. Introduction to Power BI" value={modForm.title} onChange={e => setModForm(f => ({ ...f, title: e.target.value }))} /></div>
            <div className="form-group"><label className="form-label">Topics <span style={{ color: "var(--text2)", fontWeight: 500 }}>(one per line)</span></label><textarea className="input-field" rows={4} placeholder={"What is Power BI\nArchitecture & Components\nLicensing & Versions"} value={modForm.topics} onChange={e => setModForm(f => ({ ...f, topics: e.target.value }))} style={{ resize: "vertical" }} /></div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={saveModule}>{modForm.index == null ? "＋ Add Module" : "Save Changes"}</button>
              {modForm.index != null && <button className="btn btn-secondary btn-sm" onClick={() => setModForm({ index: null, title: "", topics: "", insertAt: "" })}>Cancel edit</button>}
            </div>
          </div>
          <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 14, lineHeight: 1.6 }}>
            Then attach content: <b>Study Materials → Upload</b> (choose this course &amp; module) for the PDF, and <b>Quizzes → Create Quiz</b> (choose this course &amp; module) for its MCQs. Both menus list these modules. <b>Upload several PDFs to the same module</b> and they appear to students as numbered <b>sub-modules</b> (1.1, 1.2 …) inside that module.
          </div>
        </Modal>
      )}

      {topicsModal && <CourseTopicsModal course={topicsModal} onClose={() => setTopicsModal(null)} />}

      {modal && (
        <Modal title={modal === "add" ? "Add Course" : "Edit Course"} onClose={() => setModal(null)}>
          <div className="form-group"><label className="form-label">Course Title</label><input className="input-field" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></div>
          {isSuper && (
            <div className="form-group">
              <label className="form-label">Assign to Admin (owner)</label>
              <select className="input-field" value={form.ownerId} onChange={e => setForm({ ...form, ownerId: e.target.value })}>
                <option value="">— Unassigned —</option>
                {admins.map(a => {
                  const subs = a.subjects && a.subjects.length ? a.subjects.join(", ") : a.subject;
                  return <option key={a.id} value={a.id}>{a.name}{subs ? ` — ${subs}` : ""}</option>;
                })}
              </select>
              <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 6 }}>This admin manages the course and sees its students. Assign as many courses as you like to the same admin.</div>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="form-group">
              <label className="form-label">Category</label>
              <select className="input-field" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                {["Python", "SQL", "BI", "ML", "Excel", "R", "Tableau", "General"].map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div className="form-group"><label className="form-label">Lessons</label><input className="input-field" type="number" value={form.lessons} onChange={e => setForm({ ...form, lessons: +e.target.value })} /></div>
          </div>
          <div className="form-group"><label className="form-label">Duration (e.g. "10 hrs")</label><input className="input-field" value={form.duration} onChange={e => setForm({ ...form, duration: e.target.value })} /></div>
          <div className="form-group"><label className="form-label">Description</label><textarea className="input-field" rows={3} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} style={{ resize: "vertical" }} /></div>
          <div className="form-group">
            <label className="form-label">Color Theme</label>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              {COLORS.map(col => <button key={col} type="button" onClick={() => setForm({ ...form, color: col })} style={{ width: 34, height: 34, borderRadius: 9, background: col, border: form.color === col ? "3px solid var(--text)" : "2px solid transparent", cursor: "pointer", transition: "transform .15s", transform: form.color === col ? "scale(1.15)" : "scale(1)" }} />)}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-primary" style={{ flex: 1, justifyContent: "center" }} onClick={save}>Save Course</button>
            <button className="btn btn-secondary" onClick={() => setModal(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
};

// ─── ADMIN QUIZ ─────────────────────────────────────────────────────────────────
const AdminQuizPage = () => {
  const [quizzes, setQuizzes] = useState([]);
  const [courses, setCourses] = useState([]);
  const [modal, setModal] = useState(null);
  const [show, toastEl] = useToast();
  const [form, setForm] = useState({ courseId: "", title: "", questions: [], moduleIndex: null });
  const [newQ, setNewQ] = useState({ q: "", opts: ["", "", "", ""], ans: 0 });
  const [importing, setImporting] = useState(false);
  const pdfInputRef = useRef(null);

  const load = () => { GET("/quizzes").then(setQuizzes); GET("/courses").then(setCourses); };
  useEffect(() => { load(); }, []);

  // Import questions from an uploaded MCQ PDF (parsed in-browser, then reviewed).
  const importFromPdf = async (file) => {
    if (!file) return;
    setImporting(true);
    try {
      const uint8 = new Uint8Array(await file.arrayBuffer());
      const parsed = parseMcqLines(await extractPdfLines(uint8));
      if (!parsed.length) {
        show("No MCQs found — check the PDF layout (see the format example), and make sure it's a text PDF, not a scan.", "error");
        return;
      }
      setForm(f => {
        const base = f.questions.reduce((mx, q) => Math.max(mx, q.id || 0), 0);
        const added = parsed.map((q, i) => ({ id: base + i + 1, q: q.q, opts: q.opts, ans: q.ans }));
        return { ...f, questions: [...f.questions, ...added] };
      });
      show(`Imported ${parsed.length} question${parsed.length > 1 ? "s" : ""} — verify the correct answer on each, then Save.`);
    } catch {
      show("Couldn't read this PDF. Use a text-based PDF (not a scanned image).", "error");
    } finally {
      setImporting(false);
      if (pdfInputRef.current) pdfInputRef.current.value = "";
    }
  };

  const addQ = () => {
    if (!newQ.q || newQ.opts.some(o => !o)) return;
    setForm(f => ({ ...f, questions: [...f.questions, { id: f.questions.length + 1, ...newQ }] }));
    setNewQ({ q: "", opts: ["", "", "", ""], ans: 0 });
  };

  const selCourse = courses.find(c => c.id === form.courseId);
  const mods = selCourse ? courseModules(selCourse) : [];
  const selMod = form.moduleIndex != null ? mods[form.moduleIndex] : null;
  const shuffle = arr => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  // Auto-build starter questions from the covered topics of the chosen module.
  const autoFillFromTopics = () => {
    if (!selMod) { show("Pick a module first", "error"); return; }
    const otherTopics = mods.filter(m => m.index !== selMod.index).flatMap(m => m.topics.map(t => t.title));
    setForm(f => {
      const start = f.questions.length;
      const seeded = selMod.topics.map((t, k) => {
        const distractors = otherTopics.filter(x => x !== t.title).slice(0, 3);
        while (distractors.length < 3) distractors.push("Not covered in this module");
        const opts = shuffle([t.title, ...distractors]);
        return { id: start + k + 1, q: `Which of the following is a topic covered in ${selMod.title}?`, opts, ans: opts.indexOf(t.title) };
      });
      return { ...f, questions: [...f.questions, ...seeded] };
    });
    show(`Added ${selMod.topics.length} starter questions from the module topics — edit as needed.`);
  };

  const save = async () => {
    try {
      if (modal === "add") await POST("/quizzes", form);
      else await PUT(`/quizzes/${modal.id}`, form);
      show("Quiz saved!"); setModal(null); load();
    } catch (e) { show(e.message, "error"); }
  };

  const del = async id => {
    if (!confirm("Delete this quiz?")) return;
    try { await DELETE(`/quizzes/${id}`); show("Deleted"); load(); }
    catch (e) { show(e.message, "error"); }
  };

  return (
    <div className="fadeIn">
      {toastEl}
      <div className="section-header">
        <div><h1 className="section-title">Quizzes</h1><p style={{ color: "var(--text2)", fontSize: 13 }}>{quizzes.length} quizzes created</p></div>
        <button className="btn btn-primary" onClick={() => { setForm({ courseId: courses[0]?.id || "", title: "", questions: [], moduleIndex: null, timeLimit: "" }); setNewQ({ q: "", opts: ["", "", "", ""], ans: 0 }); setModal("add"); }}><Ico n="plus" s={15} />Create Quiz</button>
      </div>
      {quizzes.length === 0 ? <EmptyState icon="quiz" title="No quizzes yet" desc="Create your first quiz to assess your students." /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {quizzes.map(q => {
            const course = courses.find(c => c.id === q.courseId);
            return (
              <div key={q.id} className="card" style={{ padding: 20, display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ width: 46, height: 46, borderRadius: 12, background: `${course?.color || B.navy}20`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Ico n="quiz" s={22} c={course?.color || B.navy} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, color: "var(--text)" }}>{q.title}</div>
                  <div style={{ fontSize: 13, color: "var(--text2)", marginTop: 3 }}>{course?.title || "Unknown course"}{q.moduleIndex != null ? ` · Module ${q.moduleIndex + 1}` : ""} · {q.questions.length} questions{q.timeLimit ? ` · ⏱ ${q.timeLimit} min` : " · no time limit"}</div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-secondary btn-sm" onClick={() => { setForm(q); setModal(q); }}>Edit</button>
                  <button className="btn btn-danger btn-sm" onClick={() => del(q.id)}><Ico n="trash" s={14} /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {modal && (
        <Modal title={modal === "add" ? "Create Quiz" : "Edit Quiz"} onClose={() => setModal(null)} wide>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div className="form-group">
              <label className="form-label">Course</label>
              <select className="input-field" value={form.courseId} onChange={e => setForm({ ...form, courseId: +e.target.value, moduleIndex: null })}>
                {courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </div>
            <div className="form-group"><label className="form-label">Quiz Title</label><input className="input-field" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></div>
          </div>
          <div className="form-group">
            <label className="form-label">⏱ Time Limit (minutes) <span style={{ color: "var(--text2)", fontWeight: 500 }}>(how long students get to answer — leave blank for no limit)</span></label>
            <input className="input-field" type="number" min="0" placeholder="e.g. 15" value={form.timeLimit ?? ""} onChange={e => setForm({ ...form, timeLimit: e.target.value })} />
          </div>
          <div className="form-group">
            <label className="form-label">Module <span style={{ color: "var(--text2)", fontWeight: 500 }}>(students must pass this quiz to unlock the next module)</span></label>
            <select className="input-field" value={form.moduleIndex ?? ""} onChange={e => setForm({ ...form, moduleIndex: e.target.value === "" ? null : +e.target.value })}>
              <option value="">— Whole course (not tied to a module) —</option>
              {mods.map(m => <option key={m.index} value={m.index}>{m.title} — {m.topics.map(t => t.title).join(", ")}</option>)}
            </select>
          </div>
          {selMod && (
            <div style={{ background: "var(--surface2)", borderRadius: 12, padding: 14, border: "1px solid var(--border)", marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>Topics covered in {selMod.title}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                {selMod.topics.map(t => <span key={t.title} className="badge badge-navy">{t.title}</span>)}
              </div>
              <button className="btn btn-secondary btn-sm" onClick={autoFillFromTopics}><Ico n="zap" s={14} />Auto-add a question per topic</button>
              <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 8 }}>Generates one starter question per topic. Review the options and set the right answer before saving.</div>
            </div>
          )}
          {/* Import MCQs from a PDF — auto-formats into questions for review */}
          <div style={{ background: `${B.orange}0F`, borderRadius: 12, padding: 14, border: `1px solid ${B.orange}44`, marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
              <Ico n="assign" s={15} c={B.orange} />Import MCQs from a PDF
            </div>
            <div style={{ fontSize: 12, color: "var(--text2)", lineHeight: 1.6, marginBottom: 10 }}>
              Upload your question paper and we’ll auto-format it into MCQs — no need to type each one. Put each option on its own line:
              <div style={{ fontFamily: "monospace", background: "var(--surface2)", borderRadius: 8, padding: "8px 10px", marginTop: 6, whiteSpace: "pre-wrap", fontSize: 11.5, color: "var(--text)", border: "1px solid var(--border)" }}>{`1. What is 2 + 2?\nA) 3\nB) 4\nC) 5\nD) 6\nAnswer: B`}</div>
              Also accepts a)/b)/c), a “*” after the correct option, or an “Answers: 1-B 2-C …” key at the end. Every imported answer is editable below before you save.
            </div>
            <input ref={pdfInputRef} type="file" accept="application/pdf,.pdf" style={{ display: "none" }} onChange={e => importFromPdf(e.target.files?.[0])} />
            <button className="btn btn-secondary btn-sm" disabled={importing} onClick={() => pdfInputRef.current?.click()}>
              {importing ? <><Spinner size={14} />Reading PDF…</> : <><Ico n="plus" s={14} />Choose MCQ PDF</>}
            </button>
          </div>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 10 }}>Questions ({form.questions.length})</div>
            {form.questions.map((q, i) => (
              <div key={i} style={{ background: "var(--surface2)", borderRadius: 10, padding: 12, marginBottom: 8, fontSize: 13, border: "1px solid var(--border)" }}>
                <div style={{ fontWeight: 600, marginBottom: 6, color: "var(--text)" }}>{i + 1}. {q.q}</div>
                {q.opts.map((o, j) => (
                  <div key={j} onClick={() => setForm(f => ({ ...f, questions: f.questions.map((qq, ix) => ix === i ? { ...qq, ans: j } : qq) }))}
                    title="Click to mark as the correct answer"
                    style={{ color: j === q.ans ? B.success : "var(--text2)", marginLeft: 8, marginBottom: 2, cursor: "pointer", fontWeight: j === q.ans ? 700 : 400, display: "flex", gap: 6, alignItems: "flex-start" }}>
                    <span style={{ flexShrink: 0 }}>{j === q.ans ? "✓" : "○"}</span><span>{o}</span>
                  </div>
                ))}
                <button style={{ background: "none", color: B.danger, fontSize: 12, marginTop: 6, border: "none", cursor: "pointer", fontWeight: 600 }} onClick={() => setForm(f => ({ ...f, questions: f.questions.filter((_, ix) => ix !== i) }))}>Remove</button>
              </div>
            ))}
            <div style={{ background: "var(--surface2)", borderRadius: 12, padding: 16, border: "1px solid var(--border)" }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: "var(--text)" }}>Add Question</div>
              <input className="input-field" placeholder="Question text" value={newQ.q} onChange={e => setNewQ({ ...newQ, q: e.target.value })} style={{ marginBottom: 10 }} />
              {newQ.opts.map((o, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                  <input type="radio" checked={newQ.ans === i} onChange={() => setNewQ({ ...newQ, ans: i })} style={{ accentColor: B.orange }} />
                  <input className="input-field" placeholder={`Option ${i + 1}`} value={o} onChange={e => { const opts = [...newQ.opts]; opts[i] = e.target.value; setNewQ({ ...newQ, opts }); }} style={{ flex: 1 }} />
                </div>
              ))}
              <div style={{ fontSize: 11, color: "var(--text2)", marginBottom: 10 }}>Select the correct answer with the radio button.</div>
              <button className="btn btn-secondary btn-sm" onClick={addQ}><Ico n="plus" s={14} />Add Question</button>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-primary" style={{ flex: 1, justifyContent: "center" }} onClick={save}>Save Quiz</button>
            <button className="btn btn-secondary" onClick={() => setModal(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
};

// ─── ADMIN SETTINGS ────────────────────────────────────────────────────────────
const AdminSettingsPage = () => {
  const [courses, setCourses] = useState([]);
  const [batches, setBatches] = useState([]);
  const [students, setStudents] = useState([]);
  const [notifForm, setNotifForm] = useState({ title: "", body: "" });
  const [show, toastEl] = useToast();
  const { dark, toggle } = useTheme();

  const loadCourses = () => GET("/courses").then(setCourses);
  useEffect(() => {
    loadCourses();
    GET("/batches").then(setBatches).catch(() => {});
    GET("/students").then(setStudents).catch(() => {});
  }, []);

  const toggleCourse = async (course, field) => {
    try { await PUT(`/courses/${course.id}`, { ...course, [field]: !course[field] }); loadCourses(); }
    catch (e) { show(e.message, "error"); }
  };

  // Per-batch quiz control
  const quizOnForBatch = (c, batchId) => (c.quizBatch && c.quizBatch[batchId] !== undefined) ? c.quizBatch[batchId] : !!c.quizEnabled;
  const batchesForCourse = c => {
    const ids = new Set(students.filter(s => (s.enrolledCourses || []).includes(c.id)).map(s => s.batchId).filter(Boolean));
    return batches.filter(b => ids.has(b.id));
  };
  const toggleBatchQuiz = async (course, batchId, enabled) => {
    try { await PUT(`/courses/${course.id}/quiz-batch`, { batchId, enabled }); loadCourses(); show(`Quizzes ${enabled ? "enabled" : "disabled"} for that batch`); }
    catch (e) { show(e.message, "error"); }
  };

  const exportDB = async () => {
    try {
      const res = await fetch("/api/admin/export", { headers: { Authorization: `Bearer ${getToken()}` } });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `dhishaai_export_${Date.now()}.json`; a.click();
      show("Export downloaded");
    } catch (e) { show(e.message, "error"); }
  };

  // Download a CSV file from the server (with the auth token attached).
  const downloadCsv = async (path, name) => {
    try {
      const res = await fetch(path, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || "Export failed"); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
      show("CSV downloaded");
    } catch (e) { show(e.message, "error"); }
  };
  // Read our own role from the login token to decide which exports to show.
  const myRole = (() => { try { return JSON.parse(atob((getToken() || "").split(".")[1] || "")).role; } catch { return ""; } })();

  const sendNotif = async () => {
    if (!notifForm.title || !notifForm.body) { show("Fill title and message", "error"); return; }
    try { await POST("/notifications", notifForm); show("Notification sent!"); setNotifForm({ title: "", body: "" }); }
    catch (e) { show(e.message, "error"); }
  };

  return (
    <div className="fadeIn">
      {toastEl}
      <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 24, color: "var(--text)" }}>Settings</h1>
      <div style={{ display: "grid", gap: 20 }}>
        <div className="card-flat" style={{ padding: 24 }}>
          <h3 style={{ fontWeight: 700, marginBottom: 6, color: "var(--text)" }}>Appearance</h3>
          <p style={{ color: "var(--text2)", fontSize: 13, marginBottom: 16 }}>Choose your preferred theme</p>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Toggle checked={dark} onChange={toggle} />
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{dark ? "🌙 Dark Mode" : "☀️ Light Mode"}</span>
          </div>
        </div>
        <div className="card-flat" style={{ padding: 24 }}>
          <h3 style={{ fontWeight: 700, marginBottom: 6, color: "var(--text)" }}>Course Access Control</h3>
          <p style={{ color: "var(--text2)", fontSize: 13, marginBottom: 16 }}>Control syllabus and quiz access — course-wide, or per student batch</p>
          {courses.map(c => {
            const cBatches = batchesForCourse(c);
            return (
            <div key={c.id} style={{ padding: "14px 0", borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 600, color: "var(--text)" }}>{c.title}</div>
                  <div style={{ fontSize: 12, color: "var(--text2)" }}>{c.category}</div>
                </div>
                <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 12, color: "var(--text2)", fontWeight: 600 }}>SYLLABUS</span>
                    <Toggle checked={c.syllabusUnlocked} onChange={() => toggleCourse(c, "syllabusUnlocked")} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 12, color: "var(--text2)", fontWeight: 600 }}>QUIZZES (default)</span>
                    <Toggle checked={c.quizEnabled} onChange={() => toggleCourse(c, "quizEnabled")} />
                  </div>
                </div>
              </div>
              {cBatches.length > 0 && (
                <div style={{ marginTop: 12, background: "var(--surface2)", borderRadius: 10, padding: "10px 14px", border: "1px solid var(--border)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text2)", letterSpacing: .5, marginBottom: 6 }}>QUIZ ACCESS PER BATCH</div>
                  {cBatches.map(b => (
                    <div key={b.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0" }}>
                      <span style={{ fontSize: 13, color: "var(--text)" }}>{b.name}</span>
                      <Toggle checked={quizOnForBatch(c, b.id)} onChange={v => toggleBatchQuiz(c, b.id, v)} />
                    </div>
                  ))}
                  <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 6 }}>A batch toggle overrides the course default for just that batch of students.</div>
                </div>
              )}
            </div>
          );})}
        </div>
        <div className="card-flat" style={{ padding: 24 }}>
          <h3 style={{ fontWeight: 700, marginBottom: 6, color: "var(--text)" }}>Send Announcement</h3>
          <p style={{ color: "var(--text2)", fontSize: 13, marginBottom: 16 }}>Notify all your students with an important update</p>
          <div className="form-group"><label className="form-label">Title</label><input className="input-field" value={notifForm.title} onChange={e => setNotifForm({ ...notifForm, title: e.target.value })} placeholder="e.g. Class postponed to Saturday" /></div>
          <div className="form-group"><label className="form-label">Message</label><textarea className="input-field" rows={3} value={notifForm.body} onChange={e => setNotifForm({ ...notifForm, body: e.target.value })} placeholder="Your message here..." style={{ resize: "vertical" }} /></div>
          <button className="btn btn-primary" onClick={sendNotif}><Ico n="send" s={15} />Send to All Students</button>
        </div>
        <div className="card-flat" style={{ padding: 24 }}>
          <h3 style={{ fontWeight: 700, marginBottom: 6, color: "var(--text)" }}>Data Export</h3>
          <p style={{ color: "var(--text2)", fontSize: 13, marginBottom: 16 }}>Download a students roster (open in Excel) to see who is using the platform, or a full JSON backup.</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn btn-primary" onClick={() => downloadCsv("/api/admin/export/students.csv", `dhishaai_students_${Date.now()}.csv`)}><Ico n="download" s={16} />Students (CSV)</button>
            {myRole === "superadmin" && <button className="btn btn-secondary" onClick={() => downloadCsv("/api/admin/export/admins.csv", `dhishaai_admins_${Date.now()}.csv`)}><Ico n="download" s={16} />Admins (CSV)</button>}
            <button className="btn btn-secondary" onClick={exportDB}><Ico n="download" s={16} />Full backup (JSON)</button>
          </div>
        </div>
      </div>
    </div>
  );
};


// ─── STUDENT DASHBOARD ─────────────────────────────────────────────────────────
const StudentDashboard = ({ user, studentId, onOpenCourse }) => {
  const [profile, setProfile] = useState(null);
  const [courses, setCourses] = useState([]);
  const [leaderboard, setLB] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [show, toastEl] = useToast();

  const loadCatalog = () => GET("/courses/catalog").then(setCatalog).catch(() => {});
  useEffect(() => {
    Promise.all([
      GET("/profile").then(setProfile),
      GET("/courses").then(setCourses),
      GET("/leaderboard").then(setLB),
      loadCatalog(),
    ]).finally(() => setLoading(false));
  }, []);

  // Request enrollment — an admin then approves and assigns a batch.
  const requestEnroll = async (c) => {
    setCatalog(list => list.map(x => x.id === c.id ? { ...x, status: "pending" } : x)); // optimistic
    try { await POST("/enroll-requests", { courseId: c.id }); show("Request sent — waiting for admin approval"); loadCatalog(); }
    catch (e) { show(e.message, "error"); loadCatalog(); }
  };

  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={36} /></div>;

  const exploreCourses = catalog.filter(c => c.status !== "enrolled");

  const avgProgress = profile?.progress?.length > 0 ? Math.round(profile.progress.reduce((a, p) => a + p.percent, 0) / profile.progress.length) : 0;
  const rank = leaderboard.findIndex(s => s.id === profile?.id) + 1;
  const firstName = user.name.split(" ")[0];

  return (
    <div className="fadeIn">
      {toastEl}
      {/* Hero */}
      <div className="dash-hero" style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: .8, textTransform: "uppercase", color: "rgba(255,255,255,.4)", marginBottom: 3 }}>
          {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" })}
        </div>
        <div style={{ fontSize: 22, fontWeight: 800, color: "#fff", marginBottom: 3 }}>Welcome back, {firstName}! 👋</div>
        <div style={{ fontSize: 14, color: "rgba(255,255,255,.6)", marginBottom: 12 }}>Keep up your momentum — you're doing great!</div>
        {profile?.batchName && (
          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,.12)", borderRadius: 20, padding: "5px 13px", fontSize: 12.5, color: "#fff", fontWeight: 600, marginBottom: 16 }}>
            <Ico n="users" s={13} c="#fff" />Your batch: {profile.batchName}
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
          {[
            { icon: "zap", color: B.orange, val: (profile?.xp || 0).toLocaleString(), lbl: "XP" },
            { icon: "flame", color: "#FB923C", val: profile?.streak || 0, lbl: "Streak" },
            { icon: "trophy", color: "#FBBF24", val: rank > 0 ? `#${rank}` : "—", lbl: "Rank" },
            { icon: "chart", color: "#34D399", val: `${avgProgress}%`, lbl: "Progress" },
          ].map(item => (
            <div key={item.lbl} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, background: "rgba(255,255,255,.08)", borderRadius: 10, padding: "10px 6px" }}>
              <div style={{ width: 30, height: 30, borderRadius: 8, background: `${item.color}30`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Ico n={item.icon} s={15} c={item.color} />
              </div>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#fff", lineHeight: 1.1 }}>{item.val}</div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,.5)", fontWeight: 600 }}>{item.lbl}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <StatCard label="Enrolled Courses" value={profile?.enrolledCourses?.length || 0} icon="book" color="#4F46E5" />
        <StatCard label="Quizzes Completed" value={profile?.quizResults?.length || 0} icon="quiz" color="#10B981" />
        <StatCard label="Certificates" value={profile?.progress?.filter(p => p.percent >= 80).length || 0} icon="cert" color="#F59E0B" />
      </div>

      {/* Explore / request enrollment */}
      {exploreCourses.length > 0 && (
        <div className="card-flat" style={{ padding: 20, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <h3 style={{ fontWeight: 700, fontSize: 15, color: "var(--text)" }}>Explore Courses</h3>
            <span className="badge badge-navy">{exploreCourses.length} available</span>
          </div>
          <p style={{ color: "var(--text2)", fontSize: 12.5, marginBottom: 14 }}>Tap Enroll to request a course — an admin will approve it and add you to a batch.</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 12 }}>
            {exploreCourses.map(c => (
              <div key={c.id} style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
                <div style={{ height: 6, background: c.color || B.navy }} />
                <div style={{ padding: 14 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)", marginBottom: 4 }}>{c.title}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text2)", marginBottom: 12 }}>{c.category}{c.instructorName ? ` · ${c.instructorName}` : ""}</div>
                  {c.status === "pending" ? (
                    <button className="btn btn-secondary btn-sm" disabled style={{ width: "100%", justifyContent: "center", opacity: .8 }}><Ico n="clock" s={13} />Requested</button>
                  ) : (
                    <button className="btn btn-primary btn-sm" style={{ width: "100%", justifyContent: "center" }} onClick={() => requestEnroll(c)}><Ico n="plus" s={13} />Enroll</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Continue Learning */}
      {courses.length > 0 && (
        <div className="card-flat" style={{ padding: 20, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <h3 style={{ fontWeight: 700, fontSize: 15, color: "var(--text)" }}>Continue Learning</h3>
            <span className="badge badge-navy">{courses.length} enrolled</span>
          </div>
          {courses.slice(0, 3).map(c => {
            const pct = profile?.progress?.find(p => p.courseId === c.id)?.percent || 0;
            return (
              <div key={c.id} onClick={() => onOpenCourse?.(c.id)} title="Continue this course" style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", background: "var(--surface2)", borderRadius: 10, border: "1px solid var(--border)", marginBottom: 8, cursor: "pointer" }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: c.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Ico n="book" s={18} c="#fff" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", marginBottom: 5 }}>{c.title}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ flex: 1 }}><ProgressBar value={pct} height={5} /></div>
                    <span style={{ fontSize: 12, fontWeight: 700, color: B.orange, flexShrink: 0 }}>{pct}%</span>
                  </div>
                </div>
                <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 4, color: B.orange, fontWeight: 700, fontSize: 12 }}>
                  {pct > 0 ? "Continue" : "Start"}<Ico n="play" s={12} c={B.orange} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Leaderboard */}
      {leaderboard.length > 0 && (
        <div className="card-flat" style={{ padding: 20 }}>
          <h3 style={{ fontWeight: 700, fontSize: 15, color: "var(--text)", marginBottom: 14 }}>🏆 Batch Leaderboard</h3>
          {leaderboard.slice(0, 5).map((s, i) => (
            <div key={s.id} className="leaderboard-row" style={{ background: s.id === profile?.id ? `${B.orange}10` : "var(--surface)", border: s.id === profile?.id ? `1.5px solid ${B.orange}55` : "1px solid var(--border)" }}>
              <div style={{ textAlign: "center", fontWeight: 800, fontSize: i < 3 ? 18 : 13, color: i === 0 ? "#F59E0B" : i === 1 ? "#94A3B8" : i === 2 ? "#CD7C2F" : "var(--text2)" }}>
                {["🥇", "🥈", "🥉"][i] || i + 1}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
                  {s.name}{s.id === profile?.id && <span style={{ color: B.orange, fontSize: 11, marginLeft: 5, fontWeight: 700 }}>• You</span>}
                </div>
                <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 1 }}>🔥 {s.streak} day streak</div>
              </div>
              <div style={{ fontWeight: 800, color: B.orange, fontSize: 13 }}>{s.xp.toLocaleString()} XP</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── STUDENT COURSES ───────────────────────────────────────────────────────────
const StudentCoursesPage = ({ openCourseId, onConsumeOpen }) => {
  const [courses, setCourses] = useState([]);
  const [profile, setProfile] = useState(null);
  const [quizzes, setQuizzes] = useState([]);
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [activeQuiz, setActiveQuiz] = useState(null);
  const [answers, setAnswers] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [score, setScore] = useState(null);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [quizTimeLeft, setQuizTimeLeft] = useState(null);
  const [materials, setMaterials] = useState([]);
  const [viewer, setViewer] = useState(null); // material being presented in-app
  const [lessons, setLessons] = useState([]); // admin-managed course topics (live-synced)
  const [reviseMode, setReviseMode] = useState(false); // "improve my score" revision panel
  const [show, toastEl] = useToast();

  const loadProgress = () => { GET("/profile").then(setProfile); GET("/quiz-results").then(setResults).catch(() => {}); };
  useEffect(() => {
    GET("/courses").then(setCourses);
    GET("/quizzes").then(setQuizzes).catch(() => {});
    GET("/materials").then(setMaterials).catch(() => {});
    loadProgress();
  }, []);

  // Opened from "Continue Learning" — jump straight into that course's modules.
  useEffect(() => {
    if (openCourseId != null && courses.length) {
      const c = courses.find(x => x.id === openCourseId);
      if (c) setSelected(c);
      onConsumeOpen?.();
    }
  }, [openCourseId, courses]);

  // Exact course completion for the course cards — same unit formula as the
  // detail view (topics done + sub-module PDFs read + quizzes passed).
  const courseExactPct = c => {
    const { modules } = buildModules(c, quizzes);
    const prog = profile?.progress?.find(p => p.courseId === c.id);
    const doneT = prog?.completedLessons || [];
    const viewed = prog?.viewedMaterials || [];
    const isRead = id => viewed.some(v => String(v) === String(id));
    const idxSet = new Set(modules.map(m => m.index));
    const matsFor = m => materials.filter(x => Number(x.courseId) === c.id &&
      (Number(x.moduleIndex) === m.index || (m.index === 0 && (x.moduleIndex == null || x.moduleIndex === "" || !idxSet.has(Number(x.moduleIndex))))));
    const passed = q => !!q && results.some(r => r.quizId === q.id && r.total && r.score / r.total >= 0.7);
    let total = 0, dn = 0;
    modules.forEach(m => {
      m.topics.forEach(t => { total++; if (doneT.includes(t.globalIndex)) dn++; });
      matsFor(m).forEach(mat => { total++; if (isRead(mat.id)) dn++; });
      if (m.quiz) { total++; if (passed(m.quiz)) dn++; }
    });
    return total ? Math.min(100, Math.round((dn / total) * 100)) : 0;
  };

  // Pull the admin-managed topic list for the open course (kept in sync on open).
  useEffect(() => {
    setReviseMode(false); // reset revision panel when switching courses
    if (!selected) { setLessons([]); return; }
    GET(`/courses/${selected.id}/topics`)
      .then(data => setLessons(Array.isArray(data) ? data : []))
      .catch(() => setLessons([]));
  }, [selected]);

  const closeQuiz = () => { setActiveQuiz(null); setAnswers({}); setSubmitted(false); setScore(null); };

  // Keep a live ref to answers so a timer auto-submit always uses the latest picks.
  const answersRef = useRef(answers);
  answersRef.current = answers;

  const submitQuiz = async () => {
    setConfirmSubmit(false);
    const ans = answersRef.current;
    let correct = 0;
    activeQuiz.questions.forEach(q => { if (ans[q.id] === q.ans) correct++; });
    setScore(correct); setSubmitted(true);
    try {
      await POST("/quiz-results", { quizId: activeQuiz.id, courseId: selected.id, score: correct, total: activeQuiz.questions.length, answers: ans });
      loadProgress();
      show("Submitted successfully! ✓");
    } catch (e) { show(e.message, "error"); }
  };

  // Countdown for a time-limited quiz; auto-submits when it reaches zero.
  useEffect(() => {
    if (!activeQuiz || submitted || !activeQuiz.timeLimit) { setQuizTimeLeft(null); return; }
    setQuizTimeLeft(activeQuiz.timeLimit * 60);
    const t = setInterval(() => setQuizTimeLeft(s => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(t);
  }, [activeQuiz?.id, submitted]);
  useEffect(() => { if (quizTimeLeft === 0 && activeQuiz && !submitted) submitQuiz(); }, [quizTimeLeft]);

  // Anti-cheat: lock the quiz while an inline module quiz is being taken.
  useQuizGuard(!!activeQuiz && !submitted, { quizId: activeQuiz?.id, courseId: selected?.id });

  if (selected) {
    const { modules, totalTopics } = buildModules(selected, quizzes);
    const prog = profile?.progress?.find(p => p.courseId === selected.id);
    const done = prog?.completedLessons || [];
    const topicDone = gi => done.includes(gi);
    const quizPassed = quiz => !!quiz && results.some(r => r.quizId === quiz.id && r.total && r.score / r.total >= 0.7);
    // Materials the student has read all the way to the last page.
    const viewed = prog?.viewedMaterials || [];
    const materialRead = id => viewed.some(v => String(v) === String(id));
    // A material is "unassigned" if it has no module (or points at a module that
    // no longer exists). Those fold into the FIRST module so their View button
    // shows inside a module — never in a separate section.
    const moduleIdxSet = new Set(modules.map(mm => mm.index));
    const isUnassignedMat = x => Number(x.courseId) === selected.id &&
      (x.moduleIndex === null || x.moduleIndex === undefined || x.moduleIndex === "" || !moduleIdxSet.has(Number(x.moduleIndex)));
    // Sub-modules are shown in a stable, human order: numeric-aware by title/file
    // name (so "5…" < "6…" < "10…"), then by upload time — never random.
    const subOrder = (a, b) =>
      (a.title || a.fileName || "").localeCompare(b.title || b.fileName || "", undefined, { numeric: true, sensitivity: "base" })
      || String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
    const materialsForModule = m => materials.filter(x =>
      Number(x.courseId) === selected.id &&
      (Number(x.moduleIndex) === m.index || (m.index === 0 && isUnassignedMat(x)))).sort(subOrder);
    // A module can only be completed once EVERY attached PDF has been read to the
    // end. A module with no material has nothing to read, so this is vacuously true.
    const moduleMaterialsRead = m => materialsForModule(m).every(mat => materialRead(mat.id));
    const moduleTopicsDone = m => m.topics.every(t => topicDone(t.globalIndex));
    // "Studied" = topics done AND every sub-module PDF read. A 0-topic module
    // must NOT count as done just because it has no topics — its PDFs must be read.
    const moduleStudied = m => moduleTopicsDone(m) && moduleMaterialsRead(m);
    const moduleComplete = m => moduleStudied(m) && (!m.quiz || quizPassed(m.quiz));
    // When the admin manually controls release, only the released modules are open;
    // otherwise fall back to auto-unlock (finish the previous module to open the next).
    const releasedSet = selected.manualRelease ? (Array.isArray(selected.releasedModules) ? selected.releasedModules : []) : null;
    const moduleUnlocked = m => releasedSet ? releasedSet.includes(m.index) : (m.index === 0 || moduleComplete(modules[m.index - 1]));
    // Exact completion: every topic done + every sub-module PDF read + every
    // module quiz passed, over the total number of such units.
    const overallPct = (() => {
      let total = 0, dn = 0;
      modules.forEach(m => {
        m.topics.forEach(t => { total++; if (topicDone(t.globalIndex)) dn++; });
        materialsForModule(m).forEach(mat => { total++; if (materialRead(mat.id)) dn++; });
        if (m.quiz) { total++; if (quizPassed(m.quiz)) dn++; }
      });
      return total ? Math.min(100, Math.round((dn / total) * 100)) : 0;
    })();
    const allComplete = modules.length > 0 && modules.every(moduleComplete);

    // Best (highest) quiz percentage across all of a student's attempts.
    const quizzesInCourse = modules.filter(m => m.quiz).map(m => ({ module: m, quiz: m.quiz }));
    const bestPct = quizId => {
      const rs = results.filter(r => r.quizId === quizId && r.total);
      return rs.length ? Math.max(...rs.map(r => Math.round((r.score / r.total) * 100))) : 0;
    };
    const courseBestAvg = quizzesInCourse.length
      ? Math.round(quizzesInCourse.reduce((a, q) => a + bestPct(q.quiz.id), 0) / quizzesInCourse.length)
      : 0;

    // Mark a module's topics as completed (records real, persisted progress).
    const completeModuleTopics = async (m, baseDone = done) => {
      const add = m.topics.map(t => t.globalIndex).filter(gi => !baseDone.includes(gi));
      if (!add.length) return;
      const next = [...baseDone, ...add];
      const pct = Math.round((next.length / totalTopics) * 100);
      await PUT("/progress", { courseId: selected.id, percent: pct, completedLessons: next });
    };

    // Student reached the last page of a material's PDF. Record it, and if it was
    // the module's last unread PDF, AUTO-complete the module (no button needed).
    const markMaterialRead = async mat => {
      if (!mat || materialRead(mat.id)) return;
      try {
        await POST("/progress/material-viewed", { courseId: selected.id, materialId: mat.id });
        const mod = modules.find(mm => mm.index === Number(mat.moduleIndex)) || (isUnassignedMat(mat) ? modules[0] : null);
        let completed = false;
        if (mod) {
          const nowViewed = new Set([...viewed.map(String), String(mat.id)]);
          const allRead = materialsForModule(mod).every(x => nowViewed.has(String(x.id)));
          if (allRead) { await completeModuleTopics(mod); completed = true; }
        }
        await loadProgress();
        show(completed ? "✓ Module completed — you finished the material." : "Material read ✓");
      } catch (e) { /* non-blocking; they can re-open the material */ }
    };


    // Mark a whole module as studied — records real completion of its topics.
    // Guarded: every attached PDF must be read to the end first.
    const markModule = async m => {
      if (!moduleMaterialsRead(m)) { show("Open the material and read to the last page before completing this module.", "error"); return; }
      const add = m.topics.map(t => t.globalIndex).filter(gi => !done.includes(gi));
      if (!add.length) return;
      const next = [...done, ...add];
      const pct = Math.round((next.length / totalTopics) * 100);
      try { await PUT("/progress", { courseId: selected.id, percent: pct, completedLessons: next }); loadProgress(); show("Module marked as complete! ✓"); }
      catch (e) { show(e.message, "error"); }
    };

    // ── Inline module quiz taker ──
    if (activeQuiz) {
      const passRatio = submitted ? score / activeQuiz.questions.length : 0;
      const passed = submitted && passRatio >= 0.7;
      return (
        <div className="fadeIn">
          {toastEl}
          <button onClick={closeQuiz} style={{ marginBottom: 20, color: B.orange, fontWeight: 600, background: "none", border: "none", fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
            <Ico n="arrowL" s={14} c={B.orange} />Back to modules
          </button>
          <div className="card-flat" style={{ padding: "clamp(18px,4vw,28px)" }}>
            <span className="badge badge-navy" style={{ marginBottom: 8, display: "inline-block" }}>Module Quiz</span>
            <h2 style={{ fontSize: 20, fontWeight: 800, color: "var(--text)", marginBottom: 4 }}>{activeQuiz.title}</h2>
            <p style={{ color: "var(--text2)", fontSize: 14, marginBottom: 14 }}>{activeQuiz.questions.length} questions · pass with 70% to unlock the next module{activeQuiz.timeLimit ? ` · ⏱ ${activeQuiz.timeLimit} min time limit` : ""}</p>
            {quizTimeLeft != null && !submitted && (
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: quizTimeLeft < 60 ? `${B.danger}15` : "var(--surface2)", border: `1.5px solid ${quizTimeLeft < 60 ? B.danger : "var(--border)"}`, borderRadius: 10, padding: "6px 12px", marginBottom: 16 }}>
                <Ico n="clock" s={14} c={quizTimeLeft < 60 ? B.danger : "var(--text2)"} />
                <span style={{ fontWeight: 700, fontSize: 15, color: quizTimeLeft < 60 ? B.danger : "var(--text)" }}>{Math.floor(quizTimeLeft / 60)}:{String(quizTimeLeft % 60).padStart(2, "0")} left</span>
              </div>
            )}
            {!submitted && (
              <div style={{ background: `${B.danger}12`, border: `1px solid ${B.danger}44`, color: B.danger, borderRadius: 10, padding: "10px 14px", fontSize: 13, fontWeight: 600, marginBottom: 22, display: "flex", alignItems: "center", gap: 8 }}>
                <Ico n="lock" s={15} c={B.danger} />Do not switch tabs or leave this window — doing so ends the quiz, logs you out, and alerts your admin.
              </div>
            )}
            {activeQuiz.questions.map((q, qi) => (
              <div key={q.id} style={{ marginBottom: 24 }}>
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12, color: "var(--text)" }}>{qi + 1}. {q.q}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {q.opts.map((opt, oi) => {
                    let bg = "var(--surface2)", border = "var(--border)", color = "var(--text)";
                    if (answers[q.id] === oi) { bg = `${B.navy}12`; border = B.navy; }
                    if (submitted && oi === q.ans) { bg = `${B.success}15`; border = B.success; color = B.success; }
                    if (submitted && answers[q.id] === oi && oi !== q.ans) { bg = "#FEE2E2"; border = B.danger; color = B.danger; }
                    return (
                      <div key={oi} onClick={() => !submitted && setAnswers({ ...answers, [q.id]: oi })}
                        style={{ padding: "12px 16px", borderRadius: 10, border: `1.5px solid ${border}`, background: bg, color, cursor: submitted ? "default" : "pointer", fontWeight: 500, fontSize: 14, display: "flex", gap: 12, alignItems: "center" }}>
                        <div style={{ width: 26, height: 26, borderRadius: 7, border: `1.5px solid ${border}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontWeight: 700, fontSize: 12 }}>
                          {submitted && oi === q.ans ? "✓" : submitted && answers[q.id] === oi && oi !== q.ans ? "✗" : String.fromCharCode(65 + oi)}
                        </div>
                        {opt}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            {!submitted ? (
              <button className="btn btn-primary" onClick={() => setConfirmSubmit(true)} disabled={Object.keys(answers).length < activeQuiz.questions.length}>
                Submit Quiz ({Object.keys(answers).length}/{activeQuiz.questions.length} answered)
              </button>
            ) : (
              <div style={{ background: `${passed ? B.success : B.danger}12`, border: `1.5px solid ${passed ? B.success : B.danger}`, borderRadius: 16, padding: 24, textAlign: "center" }}>
                <div style={{ fontSize: 40, fontWeight: 900, color: passed ? B.success : B.danger }}>{score}/{activeQuiz.questions.length}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginTop: 6 }}>{passed ? "Passed! Next module unlocked 🎉" : "Not quite 70% — review and retry 💪"}</div>
                <div style={{ fontSize: 14, color: "var(--text2)", marginTop: 4 }}>{Math.round(passRatio * 100)}% score</div>
                <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 16, flexWrap: "wrap" }}>
                  {passed
                    ? <button className="btn btn-primary" onClick={closeQuiz}>Continue →</button>
                    : <button className="btn btn-primary" onClick={() => { setAnswers({}); setSubmitted(false); setScore(null); }}>Retry Quiz</button>}
                  <button className="btn btn-secondary" onClick={closeQuiz}>Back to modules</button>
                </div>
              </div>
            )}
          </div>
          {confirmSubmit && (
            <Modal title="Submit quiz?" onClose={() => setConfirmSubmit(false)}>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 20 }}>
                <Ico n="lock" s={20} c={B.danger} />
                <p style={{ color: "var(--text)", fontSize: 14, lineHeight: 1.6, margin: 0 }}>
                  Once submitted, your answers <b>cannot be changed</b>. Make sure you've reviewed all {activeQuiz.questions.length} questions before submitting.
                </p>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button className="btn btn-primary" style={{ flex: 1, justifyContent: "center" }} onClick={submitQuiz}>Yes, submit</button>
                <button className="btn btn-secondary" onClick={() => setConfirmSubmit(false)}>Keep reviewing</button>
              </div>
            </Modal>
          )}
        </div>
      );
    }

    // ── Module list (gated learning path) ──
    return (
      <div className="fadeIn">
        {toastEl}
        <button onClick={() => setSelected(null)} style={{ marginBottom: 20, color: B.orange, fontWeight: 600, background: "none", border: "none", fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
          <Ico n="arrowL" s={14} c={B.orange} />Back to courses
        </button>
        <div className="card-flat" style={{ padding: "clamp(18px,4vw,28px)", marginBottom: 20 }}>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
            <div style={{ width: 60, height: 60, borderRadius: 15, background: selected.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Ico n="book" s={30} c="#fff" />
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <span className="badge badge-navy" style={{ marginBottom: 8, display: "inline-block" }}>{selected.category}</span>
              <h2 style={{ fontSize: 22, fontWeight: 800, marginBottom: 4, color: "var(--text)" }}>{selected.title}</h2>
              <p style={{ color: "var(--text2)", fontSize: 14, marginBottom: 12, lineHeight: 1.5 }}>{selected.description}</p>
              <div style={{ display: "flex", gap: 20, color: "var(--text2)", fontSize: 13, flexWrap: "wrap" }}>
                <span>📦 {modules.length} modules</span><span>📚 {totalTopics} topics</span><span>⏱ {selected.duration}</span>
                {selected.instructorName && <span>👤 {selected.instructorName}</span>}
              </div>
            </div>
          </div>
          <div style={{ marginTop: 20 }}>
            <ProgressBar value={overallPct} height={10} showLabel />
          </div>
          {allComplete && (
            <div style={{ marginTop: 16, background: `${B.success}12`, border: `1.5px solid ${B.success}`, borderRadius: 12, padding: "14px 18px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <Ico n="cert" s={22} c={B.success} />
              <div style={{ fontWeight: 700, color: "var(--text)", fontSize: 14, flex: 1, minWidth: 180 }}>
                Course complete! You've passed every module quiz. 🎓
                {quizzesInCourse.length > 0 && <span style={{ display: "block", fontWeight: 600, color: "var(--text2)", fontSize: 13, marginTop: 2 }}>Your best average score: {courseBestAvg}%</span>}
              </div>
              {quizzesInCourse.length > 0 && (
                <button className="btn btn-primary btn-sm" onClick={() => setReviseMode(v => !v)} style={{ flexShrink: 0 }}>
                  <Ico n="trophy" s={14} />{reviseMode ? "Hide" : "Improve My Score"}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Revision mode — retake any quiz to beat your best score (only after full completion) */}
        {allComplete && reviseMode && quizzesInCourse.length > 0 && (
          <div className="card-flat" style={{ padding: "clamp(16px,3vw,22px)", marginBottom: 20, border: `1.5px solid ${B.orange}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <Ico n="trophy" s={18} c={B.orange} />
              <div style={{ fontWeight: 800, fontSize: 16, color: "var(--text)" }}>Improve Your Score</div>
            </div>
            <p style={{ color: "var(--text2)", fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>Re-study the material above, then retake any quiz. Your <b>highest</b> attempt is what counts — a lower retake never hurts your best score.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {quizzesInCourse.map(({ module: m, quiz }) => {
                const best = bestPct(quiz.id);
                const perfect = best >= 100;
                return (
                  <div key={quiz.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)", flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 160 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)" }}>{quiz.title}</div>
                      <div style={{ fontSize: 12, color: "var(--text2)" }}>Module {m.index + 1}: {m.title}</div>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: perfect ? B.success : B.navy, background: `${perfect ? B.success : B.navy}12`, padding: "4px 10px", borderRadius: 8, flexShrink: 0 }}>Best: {best}%</div>
                    <button className="btn btn-secondary btn-sm" disabled={perfect} onClick={() => { setAnswers({}); setSubmitted(false); setScore(null); setActiveQuiz(quiz); }} style={{ flexShrink: 0 }}>
                      <Ico n="play" s={13} />{perfect ? "Maxed ✓" : "Retake →"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {viewer && <SlideViewer materialId={viewer.id} title={viewer.title} onClose={() => setViewer(null)} onReachedEnd={() => markMaterialRead(viewer)} />}

        {lessons.length > 0 && (
          <div className="card-flat" style={{ padding: "clamp(16px,3vw,22px)", marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text2)", letterSpacing: .5, textTransform: "uppercase", marginBottom: 12 }}>Course Curriculum</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {lessons.map((t, i) => (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: "var(--text)" }}>
                  <span style={{ width: 22, height: 22, borderRadius: "50%", background: `${B.navy}18`, color: B.navy, fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i + 1}</span>
                  <span style={{ flex: 1 }}>{t.title}</span>
                  {t.duration && <span style={{ fontSize: 12, color: "var(--text2)" }}>⏱ {t.duration}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {!selected.syllabusUnlocked ? (
          <EmptyState icon="lock" title="Syllabus Not Yet Available" desc="Your instructor hasn't released the syllabus yet. Check back soon!" />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {modules.map(m => {
              const unlocked = moduleUnlocked(m);
              const complete = moduleComplete(m);
              const topicsDone = moduleTopicsDone(m);
              const studied = moduleStudied(m); // topics done AND all sub-module PDFs read
              const modMats = materialsForModule(m);
              return (
                <div key={m.index} className="card-flat" style={{ padding: 0, overflow: "hidden", opacity: unlocked ? 1 : .6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", background: "var(--surface2)", borderBottom: "1px solid var(--border)" }}>
                    <div style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: complete ? B.success : unlocked ? B.navy : "var(--border)", color: "#fff" }}>
                      {complete ? <Ico n="check" s={17} c="#fff" /> : unlocked ? <span style={{ fontWeight: 800, fontSize: 14 }}>{m.index + 1}</span> : <Ico n="lock" s={15} c="#fff" />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: 15, color: "var(--text)" }}>{m.title}</div>
                      <div style={{ fontSize: 12, color: "var(--text2)" }}>{m.topics.length} topics{modMats.length ? ` · ${modMats.length} sub-module${modMats.length > 1 ? "s" : ""}` : ""}{m.quiz ? " · 1 quiz" : ""}</div>
                    </div>
                    {complete ? <span className="badge badge-green">Completed ✓</span>
                      : !unlocked ? <span className="badge badge-navy">{selected.manualRelease ? "Not released yet" : "Locked"}</span>
                      : <span className="badge badge-orange">In progress</span>}
                  </div>

                  {unlocked && (
                    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
                      {/* Topics — what this module covers */}
                      <div style={{ padding: "12px 14px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)" }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text2)", letterSpacing: .5, textTransform: "uppercase", marginBottom: 10 }}>Topics covered in this module</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          {m.topics.map(t => (
                            <div key={t.globalIndex} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: "var(--text)" }}>
                              <div style={{ width: 7, height: 7, borderRadius: "50%", background: topicsDone ? B.success : B.orange, flexShrink: 0 }} />
                              <span style={{ flex: 1 }}>{t.title}</span>
                              {t.duration && <span style={{ fontSize: 12, color: "var(--text2)" }}>⏱ {t.duration}</span>}
                            </div>
                          ))}
                        </div>
                        {studied
                          ? <div style={{ marginTop: 12, fontSize: 13, color: B.success, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}><Ico n="check" s={14} c={B.success} />Module completed</div>
                          : modMats.length === 0
                            ? <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={() => markModule(m)}><Ico n="check" s={13} />Mark Module as Complete</button>
                            : <div style={{ marginTop: 12, fontSize: 13, color: "var(--text2)", fontWeight: 600, display: "flex", alignItems: "center", gap: 8, background: `${B.orange}12`, border: `1px solid ${B.orange}44`, borderRadius: 10, padding: "10px 14px" }}>
                                <Ico n="lock" s={14} c={B.orange} />
                                Read {modMats.length > 1 ? "all the sub-modules" : "the sub-module"} below to the last page — the module then completes automatically and the quiz unlocks.
                              </div>}
                      </div>

                      {/* Sub-modules — each attached PDF is a sub-unit of this module.
                          Sits directly above the quiz. */}
                      {modMats.length > 0 && (
                        <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)", overflow: "hidden" }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text2)", letterSpacing: .5, textTransform: "uppercase", padding: "10px 14px", borderBottom: "1px solid var(--border)", background: "var(--surface2)" }}>
                            {modMats.length > 1 ? `Sub-modules (${modMats.length})` : "Study material"}
                          </div>
                          {modMats.map((mat, si) => {
                            const read = materialRead(mat.id);
                            return (
                              <div key={mat.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderTop: si ? "1px solid var(--border)" : "none", background: read ? `${B.success}0d` : "transparent" }}>
                                <div style={{ minWidth: 40, height: 30, padding: "0 8px", borderRadius: 8, background: read ? `${B.success}18` : `${B.navy}12`, color: read ? B.success : B.navy, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontWeight: 800, fontSize: 12.5 }}>
                                  {read ? <Ico n="check" s={15} c={B.success} /> : `${m.index + 1}.${si + 1}`}
                                </div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)" }}>{mat.title}</div>
                                  <div style={{ fontSize: 12, color: read ? B.success : "var(--text2)", fontWeight: read ? 700 : 400 }}>{read ? "✓ Read to the end" : "📄 PDF · read to the last page"}</div>
                                </div>
                                <button className="btn btn-primary btn-sm" onClick={() => setViewer(mat)}><Ico n="play" s={13} />{read ? "Review" : "View"}</button>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Module quiz gate — right below the View option */}
                      {m.quiz && (
                        <div style={{ marginTop: 4, padding: "14px 16px", borderRadius: 12, border: `1.5px dashed ${quizPassed(m.quiz) ? B.success : studied ? B.orange : "var(--border)"}`, background: "var(--surface2)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                          <div style={{ width: 34, height: 34, borderRadius: 9, background: `${B.orange}18`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                            <Ico n="quiz" s={18} c={B.orange} />
                          </div>
                          <div style={{ flex: 1, minWidth: 140 }}>
                            <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)" }}>{m.quiz.title}</div>
                            <div style={{ fontSize: 12, color: "var(--text2)" }}>
                              {quizPassed(m.quiz) ? "Passed ✓ — module complete" : studied ? "Score 70%+ to unlock the next module" : modMats.length ? "Finish the sub-modules above to unlock the quiz" : "Mark the module complete above to take the quiz"}
                            </div>
                          </div>
                          {quizPassed(m.quiz)
                            ? <span className="badge badge-green">Passed ✓</span>
                            : <button className="btn btn-primary btn-sm" disabled={!studied} onClick={() => { setAnswers({}); setSubmitted(false); setScore(null); setActiveQuiz(m.quiz); }}>
                                <Ico n="play" s={13} />{results.some(r => r.quizId === m.quiz.id) ? "Retake Quiz" : "Take Quiz"} →
                              </button>}
                        </div>
                      )}
                    </div>
                  )}
                  {!unlocked && (
                    <div style={{ padding: "14px 18px", fontSize: 13, color: "var(--text2)" }}>Complete the previous module to unlock this one.</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="fadeIn">
      {toastEl}
      <div className="section-header">
        <h1 className="section-title">My Courses</h1>
        <span className="badge badge-navy">{courses.length} enrolled</span>
      </div>
      {courses.length === 0 ? (
        <EmptyState icon="book" title="No courses yet" desc="Contact your admin to get enrolled in a course." />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 20 }}>
          {courses.map(c => {
            const pct = courseExactPct(c);
            const cMods = courseModules(c);
            const cTopics = cMods.reduce((a, m) => a + m.topics.length, 0);
            return (
              <div key={c.id} className="course-card" onClick={() => setSelected(c)}>
                <div style={{ height: 110, background: `linear-gradient(135deg,${c.color},${c.color}bb)`, display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
                  <Ico n="book" s={44} c="rgba(255,255,255,.35)" />
                  <span className="badge" style={{ position: "absolute", top: 12, left: 12, background: "rgba(255,255,255,.2)", color: "#fff", backdropFilter: "blur(4px)" }}>{c.category}</span>
                  {pct >= 80 && <span style={{ position: "absolute", top: 12, right: 12, background: B.success, color: "#fff", borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 800 }}>CERTIFIED</span>}
                </div>
                <div style={{ padding: 20 }}>
                  <h3 style={{ fontWeight: 700, fontSize: 15, marginBottom: 6, color: "var(--text)" }}>{c.title}</h3>
                  <div style={{ fontSize: 12, color: "var(--text2)", marginBottom: 14, display: "flex", gap: 14, flexWrap: "wrap" }}>
                    <span>📦 {cMods.length} modules</span><span>📚 {cTopics} topics</span><span>⏱ {c.duration}</span>
                  </div>
                  <ProgressBar value={pct} height={6} showLabel />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ─── STUDENT QUIZ ──────────────────────────────────────────────────────────────
const StudentQuizPage = () => {
  const [quizzes, setQuizzes] = useState([]);
  const [results, setResults] = useState([]);
  const [active, setActive] = useState(null);
  const [answers, setAnswers] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [score, setScore] = useState(null);
  const [timeLeft, setTimeLeft] = useState(null);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [show, toastEl] = useToast();

  useEffect(() => { GET("/quizzes").then(setQuizzes); GET("/quiz-results").then(setResults); }, []);

  // Keep a live ref to answers so a timer auto-submit always uses the latest picks.
  const answersRef = useRef(answers);
  answersRef.current = answers;

  // Timer for active quiz — uses the admin-set time limit, else 60s per question.
  useEffect(() => {
    if (!active || submitted) return;
    const total = active.timeLimit ? active.timeLimit * 60 : active.questions.length * 60;
    setTimeLeft(total);
    const timer = setInterval(() => setTimeLeft(t => { if (t <= 1) { clearInterval(timer); handleSubmit(); return 0; } return t - 1; }), 1000);
    return () => clearInterval(timer);
  }, [active?.id]);

  const handleSubmit = async () => {
    setConfirmSubmit(false);
    const ans = answersRef.current;
    let correct = 0;
    active.questions.forEach(q => { if (ans[q.id] === q.ans) correct++; });
    setScore(correct); setSubmitted(true);
    try {
      await POST("/quiz-results", { quizId: active.id, courseId: active.courseId, score: correct, total: active.questions.length, answers: ans });
      GET("/quiz-results").then(setResults);
      show("Submitted successfully! ✓");
    } catch (e) { show(e.message, "error"); }
  };

  const formatTime = s => `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

  // Anti-cheat: lock the quiz while it is being taken.
  useQuizGuard(!!active && !submitted, { quizId: active?.id, courseId: active?.courseId });

  if (active) {
    const pct = active ? (Object.keys(answers).length / active.questions.length) * 100 : 0;
    return (
      <div className="fadeIn">
        {toastEl}
        <button onClick={() => { setActive(null); setAnswers({}); setSubmitted(false); setScore(null); }} style={{ marginBottom: 20, color: B.orange, fontWeight: 600, background: "none", border: "none", fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
          <Ico n="arrowL" s={14} c={B.orange} />Back
        </button>
        <div className="card-flat" style={{ padding: 28 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <h2 style={{ fontSize: 20, fontWeight: 800, color: "var(--text)" }}>{active.title}</h2>
            {timeLeft !== null && !submitted && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, background: timeLeft < 60 ? `${B.danger}15` : "var(--surface2)", border: `1.5px solid ${timeLeft < 60 ? B.danger : "var(--border)"}`, borderRadius: 10, padding: "6px 12px" }}>
                <Ico n="clock" s={14} c={timeLeft < 60 ? B.danger : "var(--text2)"} />
                <span style={{ fontWeight: 700, fontSize: 15, color: timeLeft < 60 ? B.danger : "var(--text)" }}>{formatTime(timeLeft)}</span>
              </div>
            )}
          </div>
          {!submitted && <ProgressBar value={pct} height={5} color={B.navy} />}
          <p style={{ color: "var(--text2)", fontSize: 14, marginTop: 8, marginBottom: 14 }}>{active.questions.length} questions</p>
          {!submitted && (
            <div style={{ background: `${B.danger}12`, border: `1px solid ${B.danger}44`, color: B.danger, borderRadius: 10, padding: "10px 14px", fontSize: 13, fontWeight: 600, marginBottom: 24, display: "flex", alignItems: "center", gap: 8 }}>
              <Ico n="lock" s={15} c={B.danger} />Do not switch tabs or leave this window — doing so ends the quiz, logs you out, and alerts your admin.
            </div>
          )}
          {active.questions.map((q, qi) => (
            <div key={q.id} style={{ marginBottom: 28 }}>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 12, color: "var(--text)" }}>{qi + 1}. {q.q}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {q.opts.map((opt, oi) => {
                  let bg = "var(--surface2)", border = "var(--border)", color = "var(--text)";
                  if (answers[q.id] === oi) { bg = `${B.navy}12`; border = B.navy; }
                  if (submitted && oi === q.ans) { bg = `${B.success}15`; border = B.success; color = B.success; }
                  if (submitted && answers[q.id] === oi && oi !== q.ans) { bg = "#FEE2E2"; border = B.danger; color = B.danger; }
                  return (
                    <div key={oi} onClick={() => !submitted && setAnswers({ ...answers, [q.id]: oi })}
                      style={{ padding: "12px 16px", borderRadius: 10, border: `1.5px solid ${border}`, background: bg, color, cursor: submitted ? "default" : "pointer", fontWeight: 500, fontSize: 14, transition: "all .15s", display: "flex", gap: 12, alignItems: "center" }}>
                      <div style={{ width: 26, height: 26, borderRadius: 7, border: `1.5px solid ${border}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontWeight: 700, fontSize: 12 }}>
                        {submitted && oi === q.ans ? "✓" : submitted && answers[q.id] === oi && oi !== q.ans ? "✗" : String.fromCharCode(65 + oi)}
                      </div>
                      {opt}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {!submitted ? (
            <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => setConfirmSubmit(true)} disabled={Object.keys(answers).length < active.questions.length}>
              Submit Quiz ({Object.keys(answers).length}/{active.questions.length} answered)
            </button>
          ) : (
            <div style={{ background: `${score / active.questions.length >= .7 ? B.success : B.danger}12`, border: `1.5px solid ${score / active.questions.length >= .7 ? B.success : B.danger}`, borderRadius: 16, padding: 24, textAlign: "center", marginTop: 8 }}>
              <div style={{ fontSize: 42, fontWeight: 900, color: score / active.questions.length >= .7 ? B.success : B.danger }}>{score}/{active.questions.length}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginTop: 6 }}>{score / active.questions.length >= .7 ? "Excellent work! 🎉" : "Keep practicing — you've got this! 💪"}</div>
              <div style={{ fontSize: 14, color: "var(--text2)", marginTop: 4 }}>{Math.round(score / active.questions.length * 100)}% score · +{Math.round((score / active.questions.length) * 100)} XP earned</div>
              <button className="btn btn-secondary" style={{ marginTop: 16 }} onClick={() => { setActive(null); setAnswers({}); setSubmitted(false); setScore(null); }}>Back to Quizzes</button>
            </div>
          )}
        </div>
        {confirmSubmit && (
          <Modal title="Submit quiz?" onClose={() => setConfirmSubmit(false)}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 20 }}>
              <Ico n="lock" s={20} c={B.danger} />
              <p style={{ color: "var(--text)", fontSize: 14, lineHeight: 1.6, margin: 0 }}>
                Once submitted, your answers <b>cannot be changed</b>. Make sure you've reviewed all {active.questions.length} questions before submitting.
              </p>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-primary" style={{ flex: 1, justifyContent: "center" }} onClick={handleSubmit}>Yes, submit</button>
              <button className="btn btn-secondary" onClick={() => setConfirmSubmit(false)}>Keep reviewing</button>
            </div>
          </Modal>
        )}
      </div>
    );
  }

  return (
    <div className="fadeIn">
      {toastEl}
      <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 6, color: "var(--text)" }}>Quizzes</h1>
      <p style={{ color: "var(--text2)", fontSize: 14, marginBottom: 24 }}>Test your knowledge and earn XP</p>
      {quizzes.length === 0 ? (
        <EmptyState icon="lock" title="No quizzes available" desc="Your instructor will enable quizzes when you're ready." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {quizzes.map(q => {
            const myResult = results.filter(r => r.quizId === q.id).sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))[0];
            const pct = myResult ? Math.round(myResult.score / myResult.total * 100) : null;
            return (
              <div key={q.id} className="card" style={{ padding: 24, display: "flex", alignItems: "center", gap: 18 }}>
                <div style={{ width: 54, height: 54, borderRadius: 14, background: `${B.navy}15`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Ico n="quiz" s={26} c={B.navy} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 16, color: "var(--text)" }}>{q.title}</div>
                  <div style={{ fontSize: 13, color: "var(--text2)", marginTop: 3 }}>{q.questions.length} questions · ~{q.questions.length} min</div>
                  {myResult && (
                    <div style={{ fontSize: 12, marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ color: "var(--text2)" }}>Best score:</span>
                      <span className={`badge ${pct >= 70 ? "badge-green" : "badge-red"}`}>{myResult.score}/{myResult.total} ({pct}%)</span>
                    </div>
                  )}
                </div>
                <button className="btn btn-primary btn-sm" onClick={() => { setActive(q); setAnswers({}); setSubmitted(false); setScore(null); }}>
                  {myResult ? "Retake" : "Start"} →
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};


// ─── CODING PLAYGROUND ─────────────────────────────────────────────────────────
const CodingPage = () => {
  const [code, setCode] = useState(`# Welcome to DhishaAI Python Playground! 🐍
import pandas as pd

data = {'Name': ['Alice', 'Bob', 'Charlie'],
        'Score': [95, 87, 92]}

df = pd.DataFrame(data)
print(df)
print(f"Average score: {df['Score'].mean()}")`);
  const [output, setOutput] = useState("");
  const [explain, setExplain] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("editor");

  const SNIPPETS = [
    { label: "Pandas DataFrame", code: `import pandas as pd\n\ndata = {'City': ['Mumbai','Delhi','Bengaluru'], 'Pop': [20.7,31.8,12.4]}\ndf = pd.DataFrame(data)\nprint(df)\nprint(df.describe())` },
    { label: "List Comprehension", code: `squares = [x**2 for x in range(1,11)]\nprint("Squares:", squares)\n\nevens = [x for x in range(1,21) if x%2==0]\nprint("Evens:", evens)` },
    { label: "Functions", code: `def grade(score):\n    if score>=90: return 'A'\n    elif score>=80: return 'B'\n    elif score>=70: return 'C'\n    else: return 'F'\n\nscores = {'Rahul':92,'Sneha':78,'Arjun':85}\nfor name,score in scores.items():\n    print(f'{name}: {score} → {grade(score)}')` },
    { label: "NumPy Stats", code: `import json\n\nscores = [88, 92, 75, 96, 84, 78, 90]\nmean = sum(scores)/len(scores)\nprint(f"Mean: {mean:.1f}")\nprint(f"Max: {max(scores)}")\nprint(f"Min: {min(scores)}")` },
  ];

  const runCode = async () => {
    setLoading(true); setOutput("⏳ Running your code..."); setExplain("");
    try {
      // Runs on our server (which calls Claude) — the API key stays server-side.
      const data = await POST("/ai/run", { code });
      setOutput((data.output ?? "").toString().trim() || "(no output)");
      setExplain(data.explanation || "");
    } catch (e) {
      setOutput("⚠️ " + (e.message || "Couldn't run your code right now."));
      setExplain("");
    }
    setLoading(false);
  };

  return (
    <div className="fadeIn">
      <div className="section-header">
        <div>
          <h1 className="section-title">Python Playground</h1>
          <p style={{ color: "var(--text2)", fontSize: 13 }}>Write and run Python code right in your browser</p>
        </div>
        <button className="btn btn-primary" onClick={runCode} disabled={loading}>
          {loading ? <Spinner size={16} color="#fff" /> : <Ico n="play" s={16} />}
          {loading ? "Running..." : "Run Code"}
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {SNIPPETS.map(s => <button key={s.label} className="btn btn-secondary btn-sm" onClick={() => setCode(s.code)}>{s.label}</button>)}
      </div>
      <div className="mobile-stack" style={{ alignItems: "stretch" }}>
        <div className="card-flat" style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 380 }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--surface2)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#FC5753" }} />
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#FDBC40" }} />
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#33C748" }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text2)", marginLeft: 8 }}>editor.py</span>
            </div>
            <button onClick={() => setCode("")} style={{ background: "none", color: "var(--text2)", fontSize: 12, border: "none", cursor: "pointer", fontWeight: 600 }}>Clear</button>
          </div>
          <textarea value={code} onChange={e => setCode(e.target.value)}
            style={{ flex: 1, padding: 16, fontFamily: "'Fira Code','Consolas','Courier New',monospace", fontSize: 13.5, border: "none", outline: "none", resize: "none", background: "#0f172a", color: "#e2e8f0", lineHeight: 1.75, tabSize: 4 }}
            spellCheck={false} onKeyDown={e => { if (e.key === "Tab") { e.preventDefault(); const s = e.target.selectionStart; const v = e.target.value; setCode(v.substring(0, s) + "    " + v.substring(s)); setTimeout(() => { e.target.selectionStart = e.target.selectionEnd = s + 4; }, 0); } }} />
        </div>
        <div className="card-flat" style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 240 }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, background: "var(--surface2)" }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: output && !output.startsWith("⏳") ? B.success : "#CBD5E1" }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text2)" }}>Output</span>
          </div>
          <pre style={{ flex: 1, padding: 16, fontFamily: "'Fira Code','Consolas','Courier New',monospace", fontSize: 13, background: "#0f172a", color: output.includes("Error") || output.includes("⚠️") ? "#FCA5A5" : "#86efac", overflow: "auto", margin: 0, lineHeight: 1.75, whiteSpace: "pre-wrap" }}>
            {output || "▶ Click 'Run Code' to execute"}
          </pre>
        </div>
      </div>
      {explain && (
        <div className="card-flat" style={{ padding: 16, marginTop: 12, borderLeft: `3px solid ${B.orange}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <Ico n="ai" s={16} c={B.orange} />
            <span style={{ fontWeight: 700, fontSize: 14, color: "var(--text)" }}>Explanation</span>
          </div>
          <div style={{ fontSize: 14, color: "var(--text2)", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{explain}</div>
        </div>
      )}
    </div>
  );
};

// ─── AI TUTOR ──────────────────────────────────────────────────────────────────
const AITutorPage = () => {
  const [msgs, setMsgs] = useState([{ role: "assistant", content: "Hi! I'm your DhishaAI tutor 🎓\n\nAsk me anything about **Python, SQL, Power BI, Excel, or Machine Learning**. I'll explain concepts clearly with examples!\n\nWhat would you like to learn today?" }]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  const send = async () => {
    if (!input.trim() || loading) return;
    const userMsg = { role: "user", content: input };
    const history = msgs.slice(1); // drop the initial greeting; send the real conversation
    setMsgs(m => [...m, userMsg]); setInput(""); setLoading(true);
    try {
      // Runs on our server (which calls Claude with a bounded system prompt).
      const data = await POST("/ai/tutor", { question: userMsg.content, history });
      setMsgs(m => [...m, { role: "assistant", content: data.answer || "I'm here to help — could you rephrase?" }]);
    } catch (e) {
      setMsgs(m => [...m, { role: "assistant", content: "⚠️ " + (e.message || "I'm having trouble connecting right now. Please try again in a moment.") }]);
    }
    setLoading(false);
  };

  const QUICK = ["Explain Pandas DataFrames", "What is SQL JOIN?", "How does VLOOKUP work?", "What is linear regression?", "Explain list comprehension", "What is Power BI?"];

  return (
    <div className="fadeIn ai-tutor-container" style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 124px)" }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: "var(--text)" }}>AI Tutor</h1>
        <p style={{ color: "var(--text2)", fontSize: 13 }}>Powered by Claude — available 24/7</p>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {QUICK.map(q => <button key={q} className="btn btn-secondary btn-xs" onClick={() => setInput(q)}>{q}</button>)}
      </div>
      <div className="card-flat" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
          {msgs.map((m, i) => (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
              {m.role === "assistant" && (
                <div style={{ width: 34, height: 34, borderRadius: 10, background: `${B.orange}20`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Ico n="ai" s={17} c={B.orange} />
                </div>
              )}
              <div style={{ maxWidth: "72%", padding: "12px 16px", borderRadius: m.role === "user" ? "16px 16px 4px 16px" : "16px 16px 16px 4px", background: m.role === "user" ? `linear-gradient(135deg,${B.orange},#d4601a)` : "var(--surface2)", color: m.role === "user" ? "#fff" : "var(--text)", fontSize: 14, lineHeight: 1.65, whiteSpace: "pre-wrap", border: "1px solid var(--border)", boxShadow: "0 1px 4px rgba(0,0,0,.06)" }}>
                {m.content}
              </div>
              {m.role === "user" && (
                <div style={{ width: 34, height: 34, borderRadius: 10, background: `${B.navy}20`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontWeight: 800, color: B.navy, fontSize: 13 }}>U</div>
              )}
            </div>
          ))}
          {loading && (
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <div style={{ width: 34, height: 34, borderRadius: 10, background: `${B.orange}20`, display: "flex", alignItems: "center", justifyContent: "center" }}><Ico n="ai" s={17} c={B.orange} /></div>
              <div style={{ background: "var(--surface2)", borderRadius: 12, padding: "10px 16px", display: "flex", gap: 4 }}>
                {[0, 1, 2].map(i => <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--text2)", animation: `pulse 1.2s ${i * .2}s ease-in-out infinite` }} />)}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", display: "flex", gap: 10 }}>
          <input className="input-field" style={{ flex: 1 }} placeholder="Ask anything about data analytics..." value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && !e.shiftKey && send()} />
          <button className="btn btn-primary" onClick={send} disabled={loading || !input.trim()}><Ico n="send" s={16} /></button>
        </div>
      </div>
    </div>
  );
};

// ─── PROGRESS PAGE ─────────────────────────────────────────────────────────────
const ProgressPage = () => {
  const [profile, setProfile] = useState(null);
  const [courses, setCourses] = useState([]);

  useEffect(() => { GET("/profile").then(setProfile); GET("/courses").then(setCourses); }, []);

  if (!profile) return <div style={{ padding: 60, textAlign: "center" }}><Spinner size={32} /></div>;

  const BADGES = [
    { label: "First Login", icon: "⭐", earned: true, desc: "Welcome to DhishaAI!" },
    { label: "7-Day Streak", icon: "🔥", earned: profile.streak >= 7, desc: "7 consecutive days" },
    { label: "Quiz Master", icon: "🏆", earned: (profile.quizResults?.length || 0) > 0, desc: "Completed a quiz" },
    { label: "Data Wizard", icon: "🧙", earned: profile.xp >= 2000, desc: "Earned 2000+ XP" },
    { label: "Course Champ", icon: "📚", earned: (profile.enrolledCourses?.length || 0) >= 3, desc: "3+ courses enrolled" },
    { label: "Code Ninja", icon: "💻", earned: false, desc: "Use the playground" },
  ];
  const earnedCount = BADGES.filter(b => b.earned).length;

  return (
    <div className="fadeIn">
      <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 24, color: "var(--text)" }}>My Progress</h1>
      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <StatCard label="Total XP" value={(profile.xp || 0).toLocaleString()} icon="zap" color={B.orange} />
        <StatCard label="Day Streak" value={`${profile.streak || 0} days`} icon="flame" color="#F97316" />
        <StatCard label="Badges" value={`${earnedCount}/${BADGES.length}`} icon="trophy" color="#F59E0B" />
        <StatCard label="Quizzes Done" value={profile.quizResults?.length || 0} icon="quiz" color="#10B981" />
      </div>

      {profile.progress?.length > 0 && (
        <div className="card-flat" style={{ padding: 24, marginBottom: 20 }}>
          <h3 style={{ fontWeight: 700, marginBottom: 18, color: "var(--text)", fontSize: 15 }}>Course Progress</h3>
          {profile.progress.map(p => {
            const course = courses.find(c => c.id === p.courseId);
            if (!course) return null;
            return (
              <div key={p.courseId} style={{ marginBottom: 18 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: course.color, flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, fontSize: 14, color: "var(--text)" }}>{course.title}</span>
                  </div>
                  <span style={{ fontWeight: 700, color: p.percent >= 80 ? B.success : B.orange, fontSize: 14 }}>{p.percent}%</span>
                </div>
                <ProgressBar value={p.percent} height={10} />
                {p.percent >= 80 && <div style={{ fontSize: 11, color: B.success, fontWeight: 700, marginTop: 4 }}>✓ Certificate unlocked!</div>}
              </div>
            );
          })}
        </div>
      )}

      <div className="card-flat" style={{ padding: 24, marginBottom: 20 }}>
        <h3 style={{ fontWeight: 700, marginBottom: 18, color: "var(--text)", fontSize: 15 }}>Achievements</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(130px,1fr))", gap: 14 }}>
          {BADGES.map(b => (
            <div key={b.label} style={{ textAlign: "center", padding: "16px 12px", background: b.earned ? `${B.orange}08` : "var(--surface2)", borderRadius: 14, border: `1.5px solid ${b.earned ? `${B.orange}30` : "var(--border)"}`, opacity: b.earned ? 1 : .45, transition: "all .2s" }}>
              <div style={{ fontSize: 36, marginBottom: 8 }}>{b.icon}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 3 }}>{b.label}</div>
              <div style={{ fontSize: 11, color: "var(--text2)" }}>{b.desc}</div>
              {b.earned && <div style={{ fontSize: 10, color: B.success, marginTop: 6, fontWeight: 700 }}>EARNED ✓</div>}
            </div>
          ))}
        </div>
      </div>

      {profile.quizResults?.length > 0 && (
        <div className="card-flat" style={{ padding: 24, overflow: "auto" }}>
          <h3 style={{ fontWeight: 700, marginBottom: 16, color: "var(--text)", fontSize: 15 }}>Quiz History</h3>
          <table className="data-table">
            <thead><tr><th>Quiz</th><th>Score</th><th>Date</th></tr></thead>
            <tbody>
              {profile.quizResults.slice().reverse().map(r => (
                <tr key={r.id}>
                  <td style={{ color: "var(--text)" }}>Quiz #{r.quizId}</td>
                  <td><span className={`badge ${r.score / r.total >= .7 ? "badge-green" : "badge-red"}`}>{r.score}/{r.total} ({Math.round(r.score / r.total * 100)}%)</span></td>
                  <td style={{ color: "var(--text2)", fontSize: 12 }}>{new Date(r.completedAt).toLocaleDateString("en-IN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ─── CERTIFICATES ──────────────────────────────────────────────────────────────
const CertificatesPage = ({ user }) => {
  const [profile, setProfile] = useState(null);
  const [courses, setCourses] = useState([]);
  useEffect(() => { GET("/profile").then(setProfile); GET("/courses").then(setCourses); }, []);
  const completed = profile?.progress?.filter(p => p.percent >= 80) || [];

  const downloadCert = course => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200; canvas.height = 840;
    const ctx = canvas.getContext("2d");
    // Background
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 1200, 840);
    // Border
    const grad = ctx.createLinearGradient(0, 0, 1200, 840);
    grad.addColorStop(0, "#17406E"); grad.addColorStop(1, "#E87722");
    ctx.strokeStyle = grad; ctx.lineWidth = 16; ctx.strokeRect(16, 16, 1168, 808);
    ctx.strokeStyle = "#E87722"; ctx.lineWidth = 3; ctx.strokeRect(30, 30, 1140, 780);
    // Header
    ctx.fillStyle = "#17406E"; ctx.font = "bold 18px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("DHISHAAI COMPLETE ANALYTICS", 600, 90);
    ctx.fillStyle = "#64748B"; ctx.font = "14px sans-serif";
    ctx.fillText("Bengaluru, India · www.dhishaai.com", 600, 115);
    // Divider
    ctx.strokeStyle = "#E87722"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(80, 135); ctx.lineTo(1120, 135); ctx.stroke();
    // Title
    ctx.fillStyle = "#0D2137"; ctx.font = "bold 54px Georgia, serif";
    ctx.fillText("Certificate of Completion", 600, 220);
    ctx.fillStyle = "#64748B"; ctx.font = "22px sans-serif";
    ctx.fillText("This is to certify that", 600, 280);
    // Name
    ctx.fillStyle = "#17406E"; ctx.font = "bold 48px Georgia, serif";
    ctx.fillText(user.name, 600, 360);
    ctx.strokeStyle = "#E87722"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(300, 380); ctx.lineTo(900, 380); ctx.stroke();
    // Course
    ctx.fillStyle = "#64748B"; ctx.font = "22px sans-serif";
    ctx.fillText("has successfully completed the course", 600, 430);
    ctx.fillStyle = "#E87722"; ctx.font = "bold 34px sans-serif";
    ctx.fillText(course.title, 600, 490);
    // Date & Footer
    ctx.fillStyle = "#64748B"; ctx.font = "18px sans-serif";
    ctx.fillText(`Issued on ${new Date().toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" })}`, 600, 580);
    ctx.fillStyle = "#0D2137"; ctx.font = "bold 20px sans-serif";
    ctx.fillText("DhishaAI Complete Analytics", 600, 700);
    ctx.fillStyle = "#64748B"; ctx.font = "15px sans-serif";
    ctx.fillText("contactus@dhishaai.com", 600, 728);
    const a = document.createElement("a"); a.href = canvas.toDataURL("image/png"); a.download = `DhishaAI_Certificate_${course.title.replace(/ /g, "_")}.png`; a.click();
  };

  return (
    <div className="fadeIn">
      <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 6, color: "var(--text)" }}>Certificates</h1>
      <p style={{ color: "var(--text2)", marginBottom: 24 }}>Complete 80% of a course to earn your downloadable certificate</p>
      {completed.length === 0 ? (
        <EmptyState icon="cert" title="No certificates yet" desc="Complete 80% of any course to earn a certificate." />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 20 }}>
          {completed.map(p => {
            const course = courses.find(c => c.id === p.courseId);
            if (!course) return null;
            return (
              <div key={p.courseId} className="card" style={{ padding: 32, textAlign: "center" }}>
                <div style={{ width: 72, height: 72, borderRadius: 18, background: `${course.color}20`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
                  <Ico n="cert" s={36} c={course.color} />
                </div>
                <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 6, color: "var(--text)" }}>{course.title}</div>
                <div style={{ fontSize: 13, color: "var(--text2)", marginBottom: 14 }}>Progress: {p.percent}%</div>
                <span className="badge badge-green" style={{ marginBottom: 20 }}>✓ Completed</span>
                <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={() => downloadCert(course)}>
                  <Ico n="download" s={16} />Download Certificate
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ─── FORUM ─────────────────────────────────────────────────────────────────────
const ForumPage = ({ user }) => {
  const [posts, setPosts] = useState([]);
  const [form, setForm] = useState({ title: "", body: "" });
  const [active, setActive] = useState(null);
  const [reply, setReply] = useState("");
  const [show, toastEl] = useToast();
  const [showForm, setShowForm] = useState(false);

  useEffect(() => { GET("/forum").then(setPosts); }, []);

  const createPost = async () => {
    if (!form.title || !form.body) { show("Fill title and message", "error"); return; }
    try { await POST("/forum", form); setForm({ title: "", body: "" }); setShowForm(false); GET("/forum").then(setPosts); show("Post published!"); }
    catch (e) { show(e.message, "error"); }
  };

  const addReply = async () => {
    if (!reply.trim()) return;
    try {
      await POST(`/forum/${active.id}/reply`, { body: reply }); setReply("");
      GET("/forum").then(p => { setPosts(p); setActive(p.find(x => x.id === active.id)); });
      show("Reply added");
    } catch (e) { show(e.message, "error"); }
  };

  if (active) return (
    <div className="fadeIn">
      {toastEl}
      <button onClick={() => setActive(null)} style={{ marginBottom: 20, color: B.orange, fontWeight: 600, background: "none", border: "none", fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
        <Ico n="arrowL" s={14} c={B.orange} />Back to Forum
      </button>
      <div className="card-flat" style={{ padding: 28, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
          <div style={{ width: 42, height: 42, borderRadius: 10, background: `${B.navy}15`, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, color: B.navy, flexShrink: 0, fontSize: 16 }}>{active.authorName[0]}</div>
          <div>
            <div style={{ fontWeight: 700, color: "var(--text)", display: "flex", alignItems: "center", gap: 8 }}>{active.authorName}<span className={`badge badge-${active.role === "admin" ? "orange" : "navy"}`}>{active.role}</span></div>
            <div style={{ fontSize: 12, color: "var(--text2)" }}>{new Date(active.createdAt).toLocaleDateString("en-IN")}</div>
          </div>
        </div>
        <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 12, color: "var(--text)" }}>{active.title}</h2>
        <p style={{ color: "var(--text)", lineHeight: 1.7, fontSize: 15, whiteSpace: "pre-wrap" }}>{active.body}</p>
      </div>
      <h3 style={{ fontWeight: 700, marginBottom: 12, color: "var(--text)" }}>Replies ({active.replies?.length || 0})</h3>
      {active.replies?.map(r => (
        <div key={r.id} className="card-flat" style={{ padding: 20, marginBottom: 10 }}>
          <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
            <div style={{ width: 34, height: 34, borderRadius: 8, background: `${B.orange}15`, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, color: B.orange, fontSize: 13, flexShrink: 0 }}>{r.authorName[0]}</div>
            <div><div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)" }}>{r.authorName}</div><div style={{ fontSize: 12, color: "var(--text2)" }}>{new Date(r.createdAt).toLocaleDateString("en-IN")}</div></div>
          </div>
          <p style={{ fontSize: 14, color: "var(--text)", lineHeight: 1.6 }}>{r.body}</p>
        </div>
      ))}
      <div className="card-flat" style={{ padding: 20, marginTop: 16 }}>
        <textarea className="input-field" rows={3} placeholder="Write a reply..." value={reply} onChange={e => setReply(e.target.value)} style={{ marginBottom: 10, resize: "vertical" }} />
        <button className="btn btn-primary btn-sm" onClick={addReply}><Ico n="send" s={14} />Post Reply</button>
      </div>
    </div>
  );

  return (
    <div className="fadeIn">
      {toastEl}
      <div className="section-header">
        <div>
          <h1 className="section-title">Community Forum</h1>
          <p style={{ color: "var(--text2)", fontSize: 13 }}>{posts.length} discussions</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm(v => !v)}><Ico n="plus" s={15} />New Post</button>
      </div>
      {showForm && (
        <div className="card-flat" style={{ padding: 24, marginBottom: 20 }}>
          <h3 style={{ fontWeight: 700, marginBottom: 16, color: "var(--text)" }}>Start a Discussion</h3>
          <div className="form-group"><input className="input-field" placeholder="Topic title..." value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></div>
          <div className="form-group"><textarea className="input-field" rows={4} placeholder="Share your question or insight..." value={form.body} onChange={e => setForm({ ...form, body: e.target.value })} style={{ resize: "vertical" }} /></div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={createPost}><Ico n="plus" s={14} />Publish Post</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}
      {posts.length === 0 ? <EmptyState icon="forum" title="No discussions yet" desc="Start the first discussion!" action={<button className="btn btn-primary" onClick={() => setShowForm(true)}>Start Discussion</button>} /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {posts.map(p => (
            <div key={p.id} className="card" style={{ padding: 22, cursor: "pointer" }} onClick={() => setActive(p)}>
              <div style={{ display: "flex", gap: 12 }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: `${B.navy}15`, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, color: B.navy, flexShrink: 0 }}>{p.authorName[0]}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 3, color: "var(--text)" }}>{p.title}</div>
                  <div style={{ fontSize: 12, color: "var(--text2)", marginBottom: 7 }}>by {p.authorName} · {new Date(p.createdAt).toLocaleDateString("en-IN")}</div>
                  <p style={{ fontSize: 13, color: "var(--text2)", lineHeight: 1.5 }}>{p.body.slice(0, 120)}{p.body.length > 120 ? "..." : ""}</p>
                </div>
                <div style={{ flexShrink: 0 }}><span className="badge badge-navy">{p.replies?.length || 0} replies</span></div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function fileIcon(fileType) {
  if (!fileType) return "assign";
  if (fileType.includes("pdf")) return "assign";
  if (fileType.includes("image")) return "star";
  if (fileType.includes("word") || fileType.includes("document")) return "book";
  if (fileType.includes("sheet") || fileType.includes("excel")) return "chart";
  if (fileType.includes("presentation") || fileType.includes("powerpoint")) return "zap";
  return "assign";
}

function fileColor(fileType) {
  if (!fileType) return B.navy;
  if (fileType.includes("pdf")) return "#EF4444";
  if (fileType.includes("image")) return "#8B5CF6";
  if (fileType.includes("word") || fileType.includes("document")) return "#2563EB";
  if (fileType.includes("sheet") || fileType.includes("excel")) return "#16A34A";
  if (fileType.includes("presentation") || fileType.includes("powerpoint")) return B.orange;
  return B.navy;
}

// ─── MATERIAL CARD ─────────────────────────────────────────────────────────────
const MaterialCard = ({ m, course, batch, isAdmin, onDelete, onDownload, onView }) => {
  const [downloading, setDownloading] = useState(false);
  const fc = fileColor(m.fileType);

  const handleDownload = async () => {
    setDownloading(true);
    try { await onDownload(m); }
    finally { setDownloading(false); }
  };

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      {/* Color strip top */}
      <div style={{ height: 4, background: `linear-gradient(90deg,${fc},${fc}88)` }} />
      <div style={{ padding: "16px 18px" }}>
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          {/* Icon */}
          <div style={{ width: 46, height: 46, borderRadius: 12, background: `${fc}15`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: `1.5px solid ${fc}25` }}>
            {m.fileType?.includes("image") && m.fileData
              ? <img src={m.fileData} alt="" style={{ width: 46, height: 46, objectFit: "cover", borderRadius: 10 }} />
              : <Ico n={fileIcon(m.fileType)} s={22} c={fc} />}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 3 }}>
              {m.pinned && <span style={{ fontSize: 10, fontWeight: 800, color: B.orange, background: `${B.orange}15`, padding: "2px 7px", borderRadius: 6 }}>📌 PINNED</span>}
              <span className={`badge ${m.type === "assignment" ? "badge-red" : m.type === "note" ? "badge-navy" : "badge-purple"}`}>
                {m.type === "assignment" ? "Assignment" : m.type === "note" ? "Note" : "File"}
              </span>
            </div>
            <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text)", marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.title}</div>
            {m.description && <p style={{ fontSize: 13, color: "var(--text2)", marginBottom: 8, lineHeight: 1.5 }}>{m.description}</p>}
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12, color: "var(--text2)" }}>
              {course && <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Ico n="book" s={11} />{course.title}</span>}
              {batch && !course && <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Ico n="users" s={11} />{batch.name}</span>}
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Ico n="user" s={11} />{m.adminName}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Ico n="clock" s={11} />{new Date(m.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
              {m.fileName && <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Ico n="assign" s={11} />{m.fileName} {m.fileSize ? `(${formatBytes(m.fileSize)})` : ""}</span>}
            </div>
            {m.type === "assignment" && m.dueDate && (
              <div style={{ marginTop: 8, fontSize: 13, fontWeight: 600, color: new Date(m.dueDate) < new Date() ? B.danger : "#16A34A", display: "flex", alignItems: "center", gap: 5 }}>
                <Ico n="clock" s={13} />Due: {new Date(m.dueDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                {new Date(m.dueDate) < new Date() && " (Overdue)"}
              </div>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          {/* View — shown to everyone (students only ever get view-only) */}
          {m.fileName && (
            <button className="btn btn-primary btn-sm" onClick={() => onView?.(m)} style={{ gap: 6 }}>
              <Ico n="play" s={14} />View
            </button>
          )}
          {/* Download — admins only */}
          {m.fileName && isAdmin && (
            <button className="btn btn-secondary btn-sm" onClick={handleDownload} disabled={downloading} style={{ gap: 6 }}>
              {downloading ? <Spinner size={14} color="#fff" /> : <Ico n="download" s={14} />}
              {downloading ? "Downloading..." : "Download"}
            </button>
          )}
          {isAdmin && (
            <button className="btn btn-danger btn-sm" onClick={() => onDelete(m.id)} style={{ marginLeft: "auto" }}>
              <Ico n="trash" s={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── ASSIGNMENTS + MATERIALS PAGE ─────────────────────────────────────────────
const AssignmentsPage = ({ user }) => {
  const [tab, setTab] = useState("materials");
  const [materials, setMaterials] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [courses, setCourses] = useState([]);
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [show, toastEl] = useToast();

  // Upload modal state
  const [uploadModal, setUploadModal] = useState(false);
  const [assignModal, setAssignModal] = useState(false);
  const [viewer, setViewer] = useState(null); // material being presented in-app (students)
  const [uploading, setUploading] = useState(false);
  const [filterCourse, setFilterCourse] = useState("all");
  const [filterType, setFilterType] = useState("all");

  const fileInputRef = useRef(null);
  const isAdmin = user.role === "admin" || user.role === "superadmin";

  const blankUpload = { title: "", description: "", type: "file", courseId: "", moduleIndex: "", batchId: "", pinned: false, file: null, fileData: null, fileName: null, fileType: null, fileSize: null, files: [] };
  const blankAssign = { title: "", description: "", courseId: "", batchId: "", dueDate: "" };
  const [uploadForm, setUploadForm] = useState(blankUpload);
  const [assignForm, setAssignForm] = useState(blankAssign);

  const load = () => {
    setLoading(true);
    Promise.all([
      GET("/materials").then(setMaterials),
      GET("/assignments").then(setAssignments),
      GET("/courses").then(setCourses),
      GET("/batches").then(setBatches),
    ]).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  // ── File picker (supports selecting several files → several sub-modules) ──
  const pickFile = (e) => {
    const list = Array.from(e.target.files || []);
    if (!list.length) return;
    const tooBig = list.find(f => f.size > 5 * 1024 * 1024);
    if (tooBig) { show(`"${tooBig.name}" is over 5MB`, "error"); return; }
    Promise.all(list.map(file => new Promise(res => {
      const reader = new FileReader();
      reader.onload = ev => res({ fileData: ev.target.result, fileName: file.name, fileType: file.type, fileSize: file.size });
      reader.readAsDataURL(file);
    }))).then(files => {
      setUploadForm(f => ({ ...f, files,
        fileData: files[0].fileData,
        fileName: files.length > 1 ? `${files.length} files selected` : files[0].fileName,
        fileType: files[0].fileType,
        fileSize: files.reduce((a, x) => a + x.fileSize, 0),
      }));
    });
  };

  // ── Upload material(s) ──
  const saveUpload = async () => {
    const files = (uploadForm.files && uploadForm.files.length)
      ? uploadForm.files
      : (uploadForm.fileData ? [{ fileData: uploadForm.fileData, fileName: uploadForm.fileName, fileType: uploadForm.fileType, fileSize: uploadForm.fileSize }] : []);
    const common = {
      description: uploadForm.description,
      courseId: uploadForm.courseId || null,
      moduleIndex: uploadForm.moduleIndex === "" ? null : uploadForm.moduleIndex,
      batchId: uploadForm.batchId || null,
      pinned: uploadForm.pinned,
    };
    setUploading(true);
    try {
      if (files.length > 1) {
        // Several PDFs → one material each, all on the same module (sub-modules).
        const strip = n => n.replace(/\.[^.]+$/, "");
        for (let i = 0; i < files.length; i++) {
          await POST("/materials", { ...common, type: "file",
            title: uploadForm.title ? `${uploadForm.title} ${i + 1}` : strip(files[i].fileName),
            fileData: files[i].fileData, fileName: files[i].fileName, fileType: files[i].fileType, fileSize: files[i].fileSize });
        }
        show(`${files.length} PDFs uploaded as sub-modules!`);
      } else {
        if (!uploadForm.title) { show("Title is required", "error"); setUploading(false); return; }
        const one = files[0] || {};
        await POST("/materials", { ...common, title: uploadForm.title, type: one.fileData ? "file" : "note",
          fileData: one.fileData || null, fileName: one.fileName || null, fileType: one.fileType || null, fileSize: one.fileSize || null });
        show("Material uploaded!");
      }
      setUploadModal(false);
      setUploadForm(blankUpload);
      load();
    } catch (e) { show(e.message, "error"); }
    finally { setUploading(false); }
  };

  // ── Create assignment ──
  const saveAssignment = async () => {
    if (!assignForm.title) { show("Title required", "error"); return; }
    try {
      await POST("/assignments", assignForm);
      show("Assignment created!");
      setAssignModal(false);
      setAssignForm(blankAssign);
      load();
    } catch (e) { show(e.message, "error"); }
  };

  // ── Download file ──
  const downloadMaterial = async (m) => {
    try {
      const data = await GET(`/materials/${m.id}/download`);
      const link = document.createElement("a");
      link.href = data.fileData;
      link.download = data.fileName || "download";
      link.click();
    } catch (e) { show("Download failed", "error"); }
  };

  // ── Delete ──
  const deleteMaterial = async (id) => {
    if (!confirm("Delete this material?")) return;
    try { await DELETE(`/materials/${id}`); show("Deleted"); load(); }
    catch (e) { show(e.message, "error"); }
  };
  const deleteAssignment = async (id) => {
    if (!confirm("Delete this assignment?")) return;
    try { await DELETE(`/assignments/${id}`); show("Deleted"); load(); }
    catch (e) { show(e.message, "error"); }
  };

  // ── Filtered materials ──
  const filteredMaterials = materials.filter(m => {
    if (filterCourse !== "all" && String(m.courseId) !== filterCourse) return false;
    if (filterType !== "all" && m.type !== filterType) return false;
    return true;
  });

  const pinnedMaterials = filteredMaterials.filter(m => m.pinned);
  const regularMaterials = filteredMaterials.filter(m => !m.pinned);

  // ── Render ──
  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={32} /></div>;

  return (
    <div className="fadeIn">
      {toastEl}
      {viewer && <SlideViewer materialId={viewer.id} title={viewer.title} onClose={() => setViewer(null)}
        onReachedEnd={!isAdmin && viewer.courseId ? () => { POST("/progress/material-viewed", { courseId: viewer.courseId, materialId: viewer.id }).catch(() => {}); } : undefined} />}
      <input ref={fileInputRef} type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.jpg,.jpeg,.png,.txt,.zip" style={{ display: "none" }} onChange={pickFile} />

      {/* Page Header */}
      <div className="section-header" style={{ flexWrap: "wrap", gap: 10 }}>
        <div>
          <h1 className="section-title">Study Materials</h1>
          <p style={{ color: "var(--text2)", fontSize: 13, marginTop: 2 }}>Notes, files & assignments from your instructors</p>
        </div>
        {isAdmin && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-secondary btn-sm" onClick={() => { setAssignForm(blankAssign); setAssignModal(true); }}>
              <Ico n="assign" s={14} />New Assignment
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => { setUploadForm(blankUpload); setUploadModal(true); }}>
              <Ico n="plus" s={14} />Upload Material
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="tab-bar" style={{ marginBottom: 16 }}>
        <button className={`tab ${tab === "materials" ? "active" : ""}`} onClick={() => setTab("materials")}>
          📁 Materials {materials.length > 0 && `(${materials.length})`}
        </button>
        <button className={`tab ${tab === "assignments" ? "active" : ""}`} onClick={() => setTab("assignments")}>
          📝 Assignments {assignments.length > 0 && `(${assignments.length})`}
        </button>
      </div>

      {/* ── MATERIALS TAB ── */}
      {tab === "materials" && (
        <div>
          {/* Filters */}
          {materials.length > 0 && (
            <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
              <select className="input-field" style={{ width: "auto", fontSize: 13, padding: "8px 12px" }} value={filterCourse} onChange={e => setFilterCourse(e.target.value)}>
                <option value="all">All Courses</option>
                {courses.map(c => <option key={c.id} value={String(c.id)}>{c.title}</option>)}
              </select>
              <select className="input-field" style={{ width: "auto", fontSize: 13, padding: "8px 12px" }} value={filterType} onChange={e => setFilterType(e.target.value)}>
                <option value="all">All Types</option>
                <option value="file">Files</option>
                <option value="note">Notes</option>
              </select>
            </div>
          )}

          {filteredMaterials.length === 0 ? (
            <EmptyState icon="book" title="No materials yet"
              desc={isAdmin ? "Upload notes or files for your students." : "Your instructor will upload study materials here."}
              action={isAdmin ? <button className="btn btn-primary" onClick={() => setUploadModal(true)}><Ico n="plus" s={15} />Upload First Material</button> : null}
            />
          ) : (
            <>
              {/* Pinned section */}
              {pinnedMaterials.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: B.orange, marginBottom: 10, letterSpacing: .5, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6 }}>
                    <span>📌</span> Pinned
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {pinnedMaterials.map(m => (
                      <MaterialCard key={m.id} m={m}
                        course={courses.find(c => c.id === m.courseId)}
                        batch={batches.find(b => b.id === m.batchId)}
                        isAdmin={isAdmin}
                        onDelete={deleteMaterial}
                        onDownload={downloadMaterial}
                        onView={setViewer}
                      />
                    ))}
                  </div>
                </div>
              )}
              {/* Regular */}
              {regularMaterials.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {regularMaterials.map(m => (
                    <MaterialCard key={m.id} m={m}
                      course={courses.find(c => c.id === m.courseId)}
                      batch={batches.find(b => b.id === m.batchId)}
                      isAdmin={isAdmin}
                      onDelete={deleteMaterial}
                      onDownload={downloadMaterial}
                      onView={setViewer}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── ASSIGNMENTS TAB ── */}
      {tab === "assignments" && (
        <div>
          {assignments.length === 0 ? (
            <EmptyState icon="assign" title="No assignments yet"
              desc={isAdmin ? "Create your first assignment for students." : "Your instructor will post assignments here."}
              action={isAdmin ? <button className="btn btn-primary" onClick={() => setAssignModal(true)}><Ico n="plus" s={15} />Create Assignment</button> : null}
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {assignments.map(a => {
                const course = courses.find(c => c.id === a.courseId);
                const batch = batches.find(b => b.id === a.batchId);
                const overdue = a.dueDate && new Date(a.dueDate) < new Date();
                return (
                  <div key={a.id} className="card" style={{ padding: 0, overflow: "hidden" }}>
                    <div style={{ height: 4, background: overdue ? `linear-gradient(90deg,${B.danger},${B.danger}88)` : `linear-gradient(90deg,${B.success},${B.success}88)` }} />
                    <div style={{ padding: "16px 18px" }}>
                      <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                        <div style={{ width: 46, height: 46, borderRadius: 12, background: overdue ? `${B.danger}12` : `${B.success}12`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: `1.5px solid ${overdue ? B.danger : B.success}25` }}>
                          <Ico n="assign" s={22} c={overdue ? B.danger : B.success} />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                            <span className={`badge ${overdue ? "badge-red" : "badge-green"}`}>{overdue ? "Overdue" : "Active"}</span>
                            {course && <span className="badge badge-navy">{course.title}</span>}
                            {batch && !course && <span className="badge badge-purple">{batch.name}</span>}
                          </div>
                          <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text)", marginBottom: 4 }}>{a.title}</div>
                          {a.description && <p style={{ fontSize: 13, color: "var(--text2)", lineHeight: 1.5, marginBottom: 8 }}>{a.description}</p>}
                          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, color: "var(--text2)" }}>
                            {a.adminName && <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Ico n="user" s={11} />By {a.adminName}</span>}
                            <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Ico n="clock" s={11} />Posted {new Date(a.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
                          </div>
                          {a.dueDate && (
                            <div style={{ marginTop: 10, fontSize: 13, fontWeight: 700, color: overdue ? B.danger : "#16A34A", display: "flex", alignItems: "center", gap: 5 }}>
                              <Ico n="clock" s={13} />Due: {new Date(a.dueDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}{overdue ? " — Overdue!" : ""}
                            </div>
                          )}
                        </div>
                        {isAdmin && (
                          <button className="btn btn-danger btn-xs" onClick={() => deleteAssignment(a.id)} style={{ flexShrink: 0 }}>
                            <Ico n="trash" s={12} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ═══ UPLOAD MATERIAL MODAL ═══ */}
      {uploadModal && (
        <Modal title="Upload Study Material" onClose={() => setUploadModal(false)} wide>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="form-group" style={{ gridColumn: "1/-1" }}>
              <label className="form-label">Title *</label>
              <input className="input-field" placeholder="e.g. Python Week 3 Notes" value={uploadForm.title} onChange={e => setUploadForm(f => ({ ...f, title: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Target Course</label>
              <select className="input-field" value={uploadForm.courseId} onChange={e => setUploadForm(f => ({ ...f, courseId: e.target.value, moduleIndex: "", batchId: "" }))}>
                <option value="">All enrolled students</option>
                {courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Or Target Batch</label>
              <select className="input-field" value={uploadForm.batchId} onChange={e => setUploadForm(f => ({ ...f, batchId: e.target.value, courseId: "", moduleIndex: "" }))} disabled={!!uploadForm.courseId}>
                <option value="">Select batch</option>
                {batches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            {uploadForm.courseId && (() => {
              const upCourse = courses.find(c => String(c.id) === String(uploadForm.courseId));
              const upMods = upCourse ? courseModules(upCourse) : [];
              return (
                <div className="form-group" style={{ gridColumn: "1/-1" }}>
                  <label className="form-label">Attach to Module <span style={{ color: "var(--text2)", fontWeight: 500 }}>(shows inside that module as a slide presentation)</span></label>
                  <select className="input-field" value={uploadForm.moduleIndex} onChange={e => setUploadForm(f => ({ ...f, moduleIndex: e.target.value }))}>
                    <option value="">— Not tied to a module (course-wide) —</option>
                    {upMods.map(m => <option key={m.index} value={m.index}>{m.title} — {m.topics.map(t => t.title).join(", ")}</option>)}
                  </select>
                </div>
              );
            })()}
            <div className="form-group" style={{ gridColumn: "1/-1" }}>
              <label className="form-label">Description / Instructions</label>
              <textarea className="input-field" rows={3} placeholder="Brief description of what this material covers..." value={uploadForm.description} onChange={e => setUploadForm(f => ({ ...f, description: e.target.value }))} style={{ resize: "vertical" }} />
            </div>
          </div>

          {/* File Upload Area */}
          <div
            onClick={() => fileInputRef.current?.click()}
            style={{ border: `2px dashed ${uploadForm.fileData ? B.success : "var(--border)"}`, borderRadius: 14, padding: "24px 20px", textAlign: "center", cursor: "pointer", marginBottom: 16, background: uploadForm.fileData ? `${B.success}06` : "var(--surface2)", transition: "all .2s" }}
          >
            {uploadForm.fileData ? (
              (uploadForm.files && uploadForm.files.length > 1) ? (
                <div>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>📚</div>
                  <div style={{ fontWeight: 700, color: B.success, fontSize: 14 }}>{uploadForm.files.length} PDFs selected — will be added as sub-modules</div>
                  <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 4, lineHeight: 1.5 }}>{uploadForm.files.map(f => f.fileName).join(", ")}</div>
                  <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 3 }}>Click to change</div>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>
                    {uploadForm.fileType?.includes("pdf") ? "📕" : uploadForm.fileType?.includes("image") ? "🖼️" : uploadForm.fileType?.includes("word") ? "📘" : uploadForm.fileType?.includes("sheet") ? "📗" : "📄"}
                  </div>
                  <div style={{ fontWeight: 700, color: B.success, fontSize: 14 }}>{uploadForm.fileName}</div>
                  <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 3 }}>{formatBytes(uploadForm.fileSize)} · Click to change</div>
                </div>
              )
            ) : (
              <div>
                <div style={{ fontSize: 36, marginBottom: 8 }}>📎</div>
                <div style={{ fontWeight: 600, color: "var(--text)", fontSize: 14 }}>Click to attach file(s)</div>
                <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 4 }}>PDF, Word, Excel, PowerPoint, Images · Max 5MB each · select several to add sub-modules</div>
              </div>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
            <Toggle checked={uploadForm.pinned} onChange={v => setUploadForm(f => ({ ...f, pinned: v }))} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>📌 Pin this material</div>
              <div style={{ fontSize: 12, color: "var(--text2)" }}>Pinned materials appear at the top for all students</div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-primary" style={{ flex: 1, justifyContent: "center" }} onClick={saveUpload} disabled={uploading}>
              {uploading ? <><Spinner size={16} color="#fff" />Uploading...</> : <><Ico n="plus" s={15} />Upload Material</>}
            </button>
            <button className="btn btn-secondary" onClick={() => setUploadModal(false)}>Cancel</button>
          </div>
        </Modal>
      )}

      {/* ═══ CREATE ASSIGNMENT MODAL ═══ */}
      {assignModal && (
        <Modal title="Create Assignment" onClose={() => setAssignModal(false)}>
          <div className="form-group">
            <label className="form-label">Assignment Title *</label>
            <input className="input-field" placeholder="e.g. Python Week 3 Homework" value={assignForm.title} onChange={e => setAssignForm(f => ({ ...f, title: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="form-label">Instructions / Description</label>
            <textarea className="input-field" rows={4} placeholder="What should students do? Include any links, rules, or hints..." value={assignForm.description} onChange={e => setAssignForm(f => ({ ...f, description: e.target.value }))} style={{ resize: "vertical" }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="form-group">
              <label className="form-label">Target Course</label>
              <select className="input-field" value={assignForm.courseId} onChange={e => setAssignForm(f => ({ ...f, courseId: e.target.value, batchId: "" }))}>
                <option value="">All courses</option>
                {courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Or Target Batch</label>
              <select className="input-field" value={assignForm.batchId} onChange={e => setAssignForm(f => ({ ...f, batchId: e.target.value, courseId: "" }))} disabled={!!assignForm.courseId}>
                <option value="">All batches</option>
                {batches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Due Date</label>
            <input className="input-field" type="date" value={assignForm.dueDate} onChange={e => setAssignForm(f => ({ ...f, dueDate: e.target.value }))} />
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-primary" style={{ flex: 1, justifyContent: "center" }} onClick={saveAssignment}>
              <Ico n="assign" s={15} />Create Assignment
            </button>
            <button className="btn btn-secondary" onClick={() => setAssignModal(false)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
};

// ─── LEADERBOARD ───────────────────────────────────────────────────────────────
const LeaderboardPage = () => {
  const [board, setBoard] = useState([]);
  const [profile, setProfile] = useState(null);
  useEffect(() => { GET("/leaderboard").then(setBoard); GET("/profile").then(setProfile).catch(() => {}); }, []);

  return (
    <div className="fadeIn">
      <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 6, color: "var(--text)" }}>Leaderboard</h1>
      <p style={{ color: "var(--text2)", marginBottom: 24 }}>Ranked by total XP earned</p>
      {board.slice(0, 3).length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 24 }}>
          {[board[1], board[0], board[2]].map((s, i) => s && (
            <div key={s.id} className="card" style={{ padding: "24px 16px", textAlign: "center", transform: i === 1 ? "scale(1.06)" : undefined, borderTop: i === 1 ? `4px solid ${B.orange}` : undefined }}>
              <div style={{ fontSize: 34, marginBottom: 10 }}>{i === 1 ? "🥇" : i === 0 ? "🥈" : "🥉"}</div>
              <div style={{ width: 48, height: 48, borderRadius: 12, background: `${B.navy}15`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 10px", fontWeight: 800, color: B.navy, fontSize: 18 }}>{s.name[0]}</div>
              <div style={{ fontWeight: 700, fontSize: 13, color: "var(--text)" }}>{s.name}</div>
              <div style={{ color: B.orange, fontWeight: 800, fontSize: 18, marginTop: 6 }}>{s.xp.toLocaleString()}</div>
              <div style={{ fontSize: 11, color: "var(--text2)" }}>XP</div>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {board.map((s, i) => (
          <div key={s.id} className="leaderboard-row" style={{ background: s.id === profile?.id ? `${B.orange}10` : "var(--surface)", border: s.id === profile?.id ? `1.5px solid ${B.orange}55` : "1px solid var(--border)" }}>
            <div style={{ textAlign: "center", fontWeight: 800, fontSize: i < 3 ? 20 : 15, color: i < 3 ? undefined : "var(--text2)" }}>
              {["🥇", "🥈", "🥉"][i] || i + 1}
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)" }}>{s.name}{s.id === profile?.id && <span className="badge badge-orange" style={{ marginLeft: 8, fontSize: 10 }}>You</span>}</div>
              <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 2 }}>🔥 {s.streak}d · 🏅 {s.badges} badges</div>
            </div>
            <div style={{ fontWeight: 800, color: B.orange, fontSize: 14 }}>{s.xp.toLocaleString()} XP</div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ─── NOTIFICATIONS PANEL ───────────────────────────────────────────────────────
const NotificationsPanel = ({ onClose }) => {
  const [notifs, setNotifs] = useState([]);
  useEffect(() => { GET("/notifications").then(setNotifs); }, []);

  const markRead = async id => {
    try { await PUT(`/notifications/${id}/read`); GET("/notifications").then(setNotifs); } catch {}
  };

  const markAll = async () => {
    for (const n of notifs.filter(n => !n.read)) {
      try { await PUT(`/notifications/${n.id}/read`); } catch {}
    }
    GET("/notifications").then(setNotifs);
  };

  return (
    <div className="dropdown" style={{ top: 64, right: 16, width: 360 }}>
      <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 700, color: "var(--text)", fontSize: 15 }}>Notifications</span>
        <div style={{ display: "flex", gap: 8 }}>
          {notifs.some(n => !n.read) && <button onClick={markAll} style={{ background: "none", border: "none", color: B.orange, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Mark all read</button>}
          <button onClick={onClose} className="btn-ghost" style={{ borderRadius: 8, padding: 4 }}><Ico n="x" s={16} /></button>
        </div>
      </div>
      <div style={{ maxHeight: 380, overflowY: "auto" }}>
        {notifs.length === 0 ? <div style={{ padding: 28, textAlign: "center", color: "var(--text2)", fontSize: 13 }}>No notifications</div> : (
          notifs.map(n => {
            const isViol = n.type === "violation";
            return (
              <div key={n.id} style={{ padding: "13px 18px", borderBottom: "1px solid var(--border)", borderLeft: isViol ? `3px solid ${B.danger}` : "3px solid transparent", background: isViol ? (n.read ? `${B.danger}08` : `${B.danger}12`) : (n.read ? "transparent" : `${B.orange}06`), cursor: "pointer" }} onClick={() => markRead(n.id)}>
                {!n.read && <div style={{ width: 8, height: 8, borderRadius: "50%", background: isViol ? B.danger : B.orange, marginBottom: 6 }} />}
                <div style={{ fontWeight: n.read ? 500 : 700, fontSize: 14, color: isViol ? B.danger : "var(--text)", display: "flex", alignItems: "center", gap: 6 }}>{isViol && <Ico n="lock" s={13} c={B.danger} />}{n.title}</div>
                <div style={{ fontSize: 13, color: "var(--text2)", marginTop: 4 }}>{n.body}</div>
                <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 5 }}>{new Date(n.createdAt).toLocaleDateString("en-IN")}</div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

// ─── SUPER ADMIN ───────────────────────────────────────────────────────────────
const SuperAdminDashboard = () => {
  const [data, setData] = useState(null);
  useEffect(() => { GET("/super/analytics").then(setData); }, []);
  if (!data) return <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={36} /></div>;
  return (
    <div className="fadeIn">
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: "var(--text)" }}>Platform Overview</h1>
        <p style={{ color: "var(--text2)", fontSize: 13 }}>Full visibility across all admins and students</p>
      </div>
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <StatCard label="Total Students" value={data.totalStudents} icon="users" color={B.navy} />
        <StatCard label="Course Admins" value={data.totalAdmins} icon="user" color={B.purple} />
        <StatCard label="Total Courses" value={data.totalCourses} icon="book" color="#4F46E5" />
        <StatCard label="Quiz Attempts" value={data.totalAttempts} icon="quiz" color="#10B981" />
        <StatCard label="Avg Quiz Score" value={`${data.avgScore}%`} icon="star" color="#F59E0B" />
        <StatCard label="Total Quizzes" value={data.totalQuizzes} icon="chart" color={B.orange} />
      </div>
      <div className="mobile-stack">
        <div className="card-flat" style={{ padding: 20 }}>
          <h3 style={{ fontWeight: 700, fontSize: 15, marginBottom: 16, color: "var(--text)" }}>Admin Performance</h3>
          {data.adminBreakdown.map((a, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
              <div style={{ width: 36, height: 36, borderRadius: 9, background: `${B.orange}15`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontWeight: 800, color: B.orange, fontSize: 13 }}>{a.name[0]}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
                <div style={{ fontSize: 11, color: "var(--text2)" }}>{a.subject} · {a.courses} courses · {a.students} students</div>
              </div>
            </div>
          ))}
        </div>
        <div className="card-flat" style={{ padding: 22 }}>
          <h3 style={{ fontWeight: 700, fontSize: 15, marginBottom: 16, color: "var(--text)" }}>Course Enrollment</h3>
          {data.courseBreakdown.map((c, i) => (
            <div key={i} style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                <span style={{ fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{c.title}</span>
                <span style={{ fontWeight: 700, color: B.orange, marginLeft: 8, flexShrink: 0 }}>{c.enrolled}</span>
              </div>
              <ProgressBar value={Math.min(100, (c.enrolled / Math.max(1, data.totalStudents)) * 100)} height={5} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const SuperAdminManagePage = () => {
  const [admins, setAdmins] = useState([]);
  const [courses, setCourses] = useState([]);
  const [modal, setModal] = useState(null);
  const [show, toastEl] = useToast();
  const [form, setForm] = useState({ name: "", email: "", password: "", subjects: [], phone: "", courseIds: [] });
  const SUBJECTS = ["Python", "SQL", "Power BI", "Machine Learning", "Excel", "R", "Tableau", "Data Analytics", "Deep Learning", "General"];
  const toggleSubject = s => setForm(f => ({ ...f, subjects: f.subjects.includes(s) ? f.subjects.filter(x => x !== s) : [...f.subjects, s] }));
  const toggleCourse = id => setForm(f => ({ ...f, courseIds: f.courseIds.includes(id) ? f.courseIds.filter(x => x !== id) : [...f.courseIds, id] }));

  const load = () => { GET("/super/admins").then(setAdmins); GET("/courses").then(setCourses); };
  useEffect(() => { load(); }, []);

  const save = async () => {
    try {
      if (modal === "add") await POST("/super/admins", form);
      else await PUT(`/super/admins/${modal.id}`, form);
      show("Saved"); setModal(null); load();
    } catch (e) { show(e.message, "error"); }
  };

  const del = async id => {
    if (!confirm("Delete this admin?")) return;
    try { await DELETE(`/super/admins/${id}`); show("Deleted"); load(); }
    catch (e) { show(e.message, "error"); }
  };

  return (
    <div className="fadeIn">
      {toastEl}
      <div className="section-header">
        <div><h1 className="section-title">Manage Admins</h1><p style={{ color: "var(--text2)", fontSize: 13 }}>{admins.length} course admins</p></div>
        <button className="btn btn-primary" onClick={() => { setForm({ name: "", email: "", password: "admin123", subjects: [], phone: "", courseIds: [] }); setModal("add"); }}><Ico n="plus" s={15} />Add Admin</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 16 }}>
        {admins.map(a => (
          <div key={a.id} className="card" style={{ padding: 20 }}>
            <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
              <div style={{ width: 46, height: 46, borderRadius: 12, background: `linear-gradient(135deg,${B.navy},#1a4d8a)`, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 18, flexShrink: 0 }}>{a.name[0]}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
                <div style={{ fontSize: 12, color: "var(--text2)" }}>{a.email}</div>
                <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {(() => {
                    const cats = [...new Set((a.courses || []).map(c => c.category))];
                    return cats.length
                      ? cats.map(s => <span key={s} className="badge badge-orange">{s}</span>)
                      : <span className="badge badge-navy">No courses assigned</span>;
                  })()}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
              <div style={{ flex: 1, background: "var(--surface2)", borderRadius: 9, padding: "8px 10px", textAlign: "center", border: "1px solid var(--border)" }}>
                <div style={{ fontWeight: 800, fontSize: 16, color: "var(--text)" }}>{a.courses?.length || 0}</div>
                <div style={{ fontSize: 10, color: "var(--text2)", fontWeight: 600 }}>COURSES</div>
              </div>
              <div style={{ flex: 1, background: "var(--surface2)", borderRadius: 9, padding: "8px 10px", textAlign: "center", border: "1px solid var(--border)" }}>
                <div style={{ fontWeight: 800, fontSize: 16, color: "var(--text)" }}>{a.studentCount || 0}</div>
                <div style={{ fontSize: 10, color: "var(--text2)", fontWeight: 600 }}>STUDENTS</div>
              </div>
            </div>
            {a.courses && a.courses.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 14 }}>
                {a.courses.map(c => <span key={c.id} className="badge badge-navy">{c.title}</span>)}
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-secondary btn-sm" style={{ flex: 1, justifyContent: "center" }} onClick={() => { setForm({ name: a.name, email: a.email, password: "", subjects: (a.subjects && a.subjects.length ? a.subjects : (a.subject ? [a.subject] : [])), phone: a.phone || "", courseIds: (a.courses || []).map(c => c.id) }); setModal(a); }}>Edit</button>
              <button className="btn btn-danger btn-sm" onClick={() => del(a.id)}><Ico n="trash" s={14} /></button>
            </div>
          </div>
        ))}
      </div>
      {modal && (
        <Modal title={modal === "add" ? "Add Course Admin" : "Edit Admin"} onClose={() => setModal(null)}>
          <div className="form-group"><label className="form-label">Full Name</label><input className="input-field" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
          <div className="form-group"><label className="form-label">Email</label><input className="input-field" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} disabled={modal !== "add"} /></div>
          {modal === "add" && <div className="form-group"><label className="form-label">Password</label><input className="input-field" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></div>}
          <div className="form-group">
            <label className="form-label">Assign Courses <span style={{ color: "var(--text2)", fontWeight: 500 }}>(this admin will manage these &amp; their students)</span></label>
            {courses.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--text2)" }}>No courses exist yet. Create courses in “All Courses”, then assign them here.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 7, maxHeight: 220, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 10, padding: 8 }}>
                {courses.map(c => {
                  const on = form.courseIds.includes(c.id);
                  const ownedByOther = c.ownerId && c.ownerId !== (modal !== "add" ? modal.id : null);
                  return (
                    <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, cursor: "pointer", background: on ? `${B.orange}12` : "var(--surface2)", border: `1.5px solid ${on ? B.orange : "transparent"}` }}>
                      <input type="checkbox" checked={on} onChange={() => toggleCourse(c.id)} style={{ accentColor: B.orange, width: 16, height: 16 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{c.title}</div>
                        <div style={{ fontSize: 11, color: "var(--text2)" }}>{c.category}{ownedByOther && !on ? " · currently assigned to another admin" : ""}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
            {form.courseIds.length > 0 && <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 8 }}>{form.courseIds.length} course{form.courseIds.length > 1 ? "s" : ""} assigned to this admin.</div>}
          </div>
          <div className="form-group"><label className="form-label">Phone (optional)</label><input className="input-field" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-primary" style={{ flex: 1, justifyContent: "center" }} onClick={save}>Save</button>
            <button className="btn btn-secondary" onClick={() => setModal(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
};


// ─── SUPER ADMIN: MANAGE AUTHORITIES ───────────────────────────────────────────
const SuperAuthoritiesPage = () => {
  const [auths, setAuths] = useState([]);
  const [batches, setBatches] = useState([]);
  const [modal, setModal] = useState(null);
  const [show, toastEl] = useToast();
  const [form, setForm] = useState({ name: "", email: "", password: "", batchIds: [], phone: "" });

  const load = () => { GET("/super/authorities").then(setAuths); GET("/batches").then(setBatches); };
  useEffect(() => { load(); }, []);
  const toggleBatch = id => setForm(f => ({ ...f, batchIds: f.batchIds.includes(id) ? f.batchIds.filter(x => x !== id) : [...f.batchIds, id] }));

  const save = async () => {
    if (!form.name || !form.email) { show("Name and email required", "error"); return; }
    try {
      if (modal === "add") await POST("/super/authorities", form);
      else await PUT(`/super/authorities/${modal.id}`, form);
      show("Saved"); setModal(null); load();
    } catch (e) { show(e.message, "error"); }
  };
  const del = async id => {
    if (!confirm("Remove this authority?")) return;
    try { await DELETE(`/super/authorities/${id}`); show("Removed"); load(); }
    catch (e) { show(e.message, "error"); }
  };

  return (
    <div className="fadeIn">
      {toastEl}
      <div className="section-header">
        <div><h1 className="section-title">Authorities</h1><p style={{ color: "var(--text2)", fontSize: 13 }}>{auths.length} batch monitors · read-only access</p></div>
        <button className="btn btn-primary" onClick={() => { setForm({ name: "", email: "", password: "authority123", batchIds: [], phone: "" }); setModal("add"); }}><Ico n="plus" s={15} />Add Authority</button>
      </div>
      {auths.length === 0 ? <EmptyState icon="shield" title="No authorities yet" desc="Add an authority and assign them batches to monitor." /> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 16 }}>
          {auths.map(a => (
            <div key={a.id} className="card" style={{ padding: 20 }}>
              <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
                <div style={{ width: 46, height: 46, borderRadius: 12, background: `linear-gradient(135deg,${B.purple},#9d5cf5)`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Ico n="shield" s={22} c="#fff" /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
                  <div style={{ fontSize: 12, color: "var(--text2)" }}>{a.email}</div>
                  <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 5 }}>
                    {(a.batches && a.batches.length) ? a.batches.map(b => <span key={b.id} className="badge badge-purple">{b.name}</span>) : <span className="badge badge-navy">No batch assigned</span>}
                  </div>
                </div>
              </div>
              <div style={{ background: "var(--surface2)", borderRadius: 9, padding: "8px 10px", textAlign: "center", border: "1px solid var(--border)", marginBottom: 14 }}>
                <div style={{ fontWeight: 800, fontSize: 16, color: "var(--text)" }}>{a.studentCount || 0}</div>
                <div style={{ fontSize: 10, color: "var(--text2)", fontWeight: 600 }}>STUDENTS MONITORED</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-secondary btn-sm" style={{ flex: 1, justifyContent: "center" }} onClick={() => { setForm({ name: a.name, email: a.email, password: "", batchIds: a.batchIds || [], phone: a.phone || "" }); setModal(a); }}>Edit</button>
                <button className="btn btn-danger btn-sm" onClick={() => del(a.id)}><Ico n="trash" s={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {modal && (
        <Modal title={modal === "add" ? "Add Authority" : "Edit Authority"} onClose={() => setModal(null)}>
          <div className="form-group"><label className="form-label">Full Name</label><input className="input-field" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
          <div className="form-group"><label className="form-label">Email</label><input className="input-field" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} disabled={modal !== "add"} /></div>
          {modal === "add" && <div className="form-group"><label className="form-label">Password</label><input className="input-field" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></div>}
          <div className="form-group">
            <label className="form-label">Assign Batches <span style={{ color: "var(--text2)", fontWeight: 500 }}>(authority sees only these batches' students)</span></label>
            {batches.length === 0 ? <div style={{ fontSize: 13, color: "var(--text2)" }}>No batches exist yet.</div> : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {batches.map(b => {
                  const on = form.batchIds.includes(b.id);
                  return <button key={b.id} type="button" onClick={() => toggleBatch(b.id)} style={{ padding: "7px 14px", borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: "pointer", border: `1.5px solid ${on ? B.purple : "var(--border)"}`, background: on ? B.purple : "var(--surface2)", color: on ? "#fff" : "var(--text2)" }}>{on ? "✓ " : ""}{b.name}</button>;
                })}
              </div>
            )}
          </div>
          <div className="form-group"><label className="form-label">Phone (optional)</label><input className="input-field" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-primary" style={{ flex: 1, justifyContent: "center" }} onClick={save}>Save</button>
            <button className="btn btn-secondary" onClick={() => setModal(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
};

// ─── AUTHORITY: READ-ONLY BATCH REPORT ─────────────────────────────────────────
const AuthorityPage = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);
  const [search, setSearch] = useState("");

  useEffect(() => { GET("/authority/data").then(setData).catch(() => {}).finally(() => setLoading(false)); }, []);

  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={36} /></div>;
  if (!data) return <EmptyState icon="shield" title="No data available" desc="No batches assigned yet. Ask the super admin to assign you a batch." />;

  const students = data.students.filter(s => s.name.toLowerCase().includes(search.toLowerCase()) || (s.email || "").toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="fadeIn">
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: "var(--text)" }}>Batch Report</h1>
        <p style={{ color: "var(--text2)", fontSize: 13, marginTop: 3 }}>Read-only view of your assigned batch{data.stats.batchCount > 1 ? "es" : ""}</p>
      </div>
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <StatCard label="Students" value={data.stats.totalStudents} icon="users" color={B.navy} />
        <StatCard label="Attending / Active" value={`${data.stats.activeStudents}/${data.stats.totalStudents}`} icon="flame" color="#EF4444" />
        <StatCard label="Avg Progress" value={`${data.stats.avgProgress}%`} icon="progress" color={B.orange} />
        <StatCard label="Avg Quiz Score" value={`${data.stats.avgQuiz}%`} icon="quiz" color="#10B981" />
      </div>

      {data.batches.length > 0 && (
        <div className="card-flat" style={{ padding: 20, marginBottom: 20 }}>
          <h3 style={{ fontWeight: 700, fontSize: 15, marginBottom: 14, color: "var(--text)" }}>Batches</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 12 }}>
            {data.batches.map(b => (
              <div key={b.id} style={{ background: "var(--surface2)", borderRadius: 12, padding: 16, border: "1px solid var(--border)" }}>
                <div style={{ fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>{b.name}</div>
                <div style={{ fontSize: 13, color: "var(--text2)", marginBottom: 8 }}>{b.total} students · {b.active} active</div>
                <ProgressBar value={b.avgProgress} height={6} showLabel />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card-flat" style={{ overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h3 style={{ fontWeight: 700, fontSize: 15, color: "var(--text)" }}>Students ({students.length})</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--surface2)", borderRadius: 9, padding: "8px 12px", border: "1px solid var(--border)" }}>
            <Ico n="search" s={15} c="var(--text2)" />
            <input style={{ background: "none", border: "none", fontSize: 14, color: "var(--text)", outline: "none" }} placeholder="Search students..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
        <div style={{ overflow: "auto" }}>
          <table className="data-table">
            <thead><tr><th>Student</th><th>Batch</th><th>Progress</th><th>Quiz Avg</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {students.length === 0 ? <tr><td colSpan={6} style={{ textAlign: "center", padding: 30, color: "var(--text2)" }}>No students found</td></tr> :
              students.map(s => (
                <tr key={s.id}>
                  <td><div style={{ fontWeight: 600, color: "var(--text)" }}>{s.name}</div><div style={{ fontSize: 12, color: "var(--text2)" }}>{s.email}</div></td>
                  <td>{s.batchName}</td>
                  <td><div style={{ minWidth: 90 }}><ProgressBar value={s.avgProgress} height={6} showLabel /></div></td>
                  <td><span className={`badge ${s.quizAvg >= 70 ? "badge-green" : s.quizResults.length ? "badge-red" : "badge-navy"}`}>{s.quizResults.length ? `${s.quizAvg}%` : "—"}</span></td>
                  <td><span className={`badge ${s.active ? "badge-green" : "badge-navy"}`}>{s.active ? "Active" : "Inactive"}</span></td>
                  <td><button className="btn btn-secondary btn-sm" onClick={() => setDetail(s)}>View more</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {detail && (
        <Modal title={detail.name} onClose={() => setDetail(null)} wide>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 18 }}>
            <span className="badge badge-purple">{detail.batchName}</span>
            <span className="badge badge-navy">{detail.email}</span>
            {detail.phone && <span className="badge badge-navy">📞 {detail.phone}</span>}
            {detail.qualification && <span className="badge badge-navy">🎓 {detail.qualification}</span>}
            {detail.experience && <span className="badge badge-navy">💼 {detail.experience}</span>}
            {detail.company && <span className="badge badge-navy">🏢 {detail.company}</span>}
          </div>
          <div className="stat-grid" style={{ marginBottom: 20 }}>
            <StatCard label="XP" value={(detail.xp).toLocaleString()} icon="zap" color={B.orange} />
            <StatCard label="Streak" value={`${detail.streak}d`} icon="flame" color="#EF4444" />
            <StatCard label="Avg Progress" value={`${detail.avgProgress}%`} icon="progress" color={B.navy} />
            <StatCard label="Quiz Avg" value={detail.quizResults.length ? `${detail.quizAvg}%` : "—"} icon="quiz" color="#10B981" />
          </div>
          <div style={{ marginBottom: 20 }}>
            <h4 style={{ fontWeight: 700, fontSize: 14, marginBottom: 10, color: "var(--text)" }}>Courses &amp; Progress</h4>
            {detail.courses.length === 0 ? <div style={{ fontSize: 13, color: "var(--text2)" }}>Not enrolled in any course.</div> :
            detail.courses.map(c => (
              <div key={c.id} style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 5 }}>
                  <span style={{ fontWeight: 600, color: "var(--text)" }}>{c.title}</span>
                  <span style={{ fontWeight: 700, color: B.orange }}>{c.percent}%</span>
                </div>
                <ProgressBar value={c.percent} height={6} />
              </div>
            ))}
          </div>
          <div>
            <h4 style={{ fontWeight: 700, fontSize: 14, marginBottom: 10, color: "var(--text)" }}>Quiz Results ({detail.quizResults.length})</h4>
            {detail.quizResults.length === 0 ? <div style={{ fontSize: 13, color: "var(--text2)" }}>No quizzes attempted yet.</div> :
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {detail.quizResults.map((r, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--surface2)", borderRadius: 10, padding: "10px 14px", border: "1px solid var(--border)" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{r.quizTitle}</span>
                  <span className={`badge ${r.pct >= 70 ? "badge-green" : "badge-red"}`}>{r.score}/{r.total} ({r.pct}%)</span>
                </div>
              ))}
            </div>}
          </div>
        </Modal>
      )}
    </div>
  );
};

// ─── STUDY PLANNER ─────────────────────────────────────────────────────────────
const StudyPlannerPage = () => {
  const [plan, setPlan] = useState([]);
  const [courses, setCourses] = useState([]);
  const [form, setForm] = useState({ date: new Date().toISOString().split("T")[0], title: "", duration: 60, courseId: "" });
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [show, toastEl] = useToast();

  useEffect(() => {
    GET("/study-plan").then(setPlan).catch(() => {});
    GET("/courses").then(setCourses).catch(() => {});
  }, []);

  const today = new Date().toISOString().split("T")[0];
  const todayItems = plan.filter(p => p.date === today);
  const upcomingItems = plan.filter(p => p.date > today);
  const pastItems = plan.filter(p => p.date < today).sort((a,b) => b.date.localeCompare(a.date));
  const totalPlanned = plan.reduce((s, p) => s + (p.duration || 60), 0);
  const totalDone = plan.filter(p => p.done).reduce((s, p) => s + (p.duration || 60), 0);

  const addItem = async () => {
    if (!form.title.trim()) { show("Enter a title", "error"); return; }
    setLoading(true);
    try {
      const item = await POST("/study-plan", form);
      setPlan(p => [...p, item]);
      setForm({ date: today, title: "", duration: 60, courseId: "" });
      setShowForm(false);
      show("Study session added!");
    } catch(e) { show(e.message, "error"); }
    setLoading(false);
  };

  const toggleDone = async (item) => {
    try {
      const updated = await PUT(`/study-plan/${item.id}`, { done: !item.done });
      setPlan(p => p.map(x => x.id === item.id ? updated : x));
    } catch(e) { show(e.message, "error"); }
  };

  const deleteItem = async (id) => {
    try {
      await DELETE(`/study-plan/${id}`);
      setPlan(p => p.filter(x => x.id !== id));
      show("Removed");
    } catch(e) { show(e.message, "error"); }
  };

  const PlanItem = ({ item }) => {
    const course = courses.find(c => c.id == item.courseId);
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", background: item.done ? "var(--surface2)" : "var(--surface)", borderRadius: 12, border: `1px solid ${item.done ? "var(--border)" : "var(--border)"}`, opacity: item.done ? 0.65 : 1, transition: "all .2s" }}>
        <button onClick={() => toggleDone(item)} style={{ width: 24, height: 24, borderRadius: 8, border: `2px solid ${item.done ? B.success : "var(--input-border)"}`, background: item.done ? B.success : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "pointer" }}>
          {item.done && <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="#fff" strokeWidth="2" strokeLinecap="round"/></svg>}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)", textDecoration: item.done ? "line-through" : "none" }}>{item.title}</div>
          <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 2 }}>
            ⏱ {item.duration} min{course ? ` · ${course.title}` : ""}
          </div>
        </div>
        <button onClick={() => deleteItem(item.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text2)", padding: 4, borderRadius: 6 }}>
          <Ico n="x" s={14} />
        </button>
      </div>
    );
  };

  return (
    <div className="fadeIn">
      {toastEl}
      <div className="section-header">
        <div>
          <h1 className="section-title">Study Planner</h1>
          <p style={{ color: "var(--text2)", fontSize: 13 }}>Plan and track your daily learning sessions</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm(v => !v)}><Ico n="plus" s={15} />Add Session</button>
      </div>

      {/* Stats */}
      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <StatCard label="Sessions Planned" value={plan.length} icon="book" color={B.navy} />
        <StatCard label="Completed" value={plan.filter(p=>p.done).length} icon="cert" color={B.success} />
        <StatCard label="Hours Planned" value={`${(totalPlanned/60).toFixed(1)}h`} icon="flame" color={B.orange} />
        <StatCard label="Hours Done" value={`${(totalDone/60).toFixed(1)}h`} icon="zap" color="#7C3AED" />
      </div>

      {/* Add Form */}
      {showForm && (
        <div className="card-flat" style={{ padding: 24, marginBottom: 20 }}>
          <h3 style={{ fontWeight: 700, marginBottom: 16, color: "var(--text)", fontSize: 15 }}>Schedule a Study Session</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Date</label>
              <input type="date" className="input-field" value={form.date} onChange={e => setForm({...form, date: e.target.value})} min={today} />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Duration (minutes)</label>
              <select className="input-field" value={form.duration} onChange={e => setForm({...form, duration: parseInt(e.target.value)})}>
                {[30,45,60,90,120].map(d => <option key={d} value={d}>{d} min</option>)}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Topic / Task</label>
            <input className="input-field" placeholder="e.g. Practice SQL JOINs, Complete Pandas chapter..." value={form.title} onChange={e => setForm({...form, title: e.target.value})} />
          </div>
          <div className="form-group" style={{ marginBottom: 16 }}>
            <label className="form-label">Link to Course (optional)</label>
            <select className="input-field" value={form.courseId} onChange={e => setForm({...form, courseId: e.target.value})}>
              <option value="">— No course —</option>
              {courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={addItem} disabled={loading}>{loading ? <Spinner size={14} color="#fff" /> : <Ico n="plus" s={14} />}Add Session</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Today */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12, color: "var(--text)", display: "flex", alignItems: "center", gap: 8 }}>
          📅 Today
          <span className="badge badge-orange">{todayItems.length}</span>
        </div>
        {todayItems.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text2)", fontSize: 14, background: "var(--surface2)", borderRadius: 12 }}>No sessions planned for today. <button style={{ color: B.orange, background: "none", border: "none", cursor: "pointer", fontWeight: 600 }} onClick={() => setShowForm(true)}>Add one →</button></div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{todayItems.map(item => <PlanItem key={item.id} item={item} />)}</div>
        )}
      </div>

      {/* Upcoming */}
      {upcomingItems.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12, color: "var(--text)", display: "flex", alignItems: "center", gap: 8 }}>📆 Upcoming <span className="badge badge-navy">{upcomingItems.length}</span></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{upcomingItems.slice(0,5).map(item => <PlanItem key={item.id} item={item} />)}</div>
        </div>
      )}

      {/* Past */}
      {pastItems.length > 0 && (
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12, color: "var(--text)" }}>🕒 Past Sessions</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{pastItems.slice(0,5).map(item => <PlanItem key={item.id} item={item} />)}</div>
        </div>
      )}
    </div>
  );
};

// ─── CAREER ROADMAP ─────────────────────────────────────────────────────────────
const CareerPage = () => {
  const [career, setCareer] = useState({ goal: "", targetRole: "", targetDate: "", notes: "", milestones: [] });
  const [saving, setSaving] = useState(false);
  const [aiAdvice, setAiAdvice] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [show, toastEl] = useToast();
  const [courses, setCourses] = useState([]);
  const [profile, setProfile] = useState(null);

  useEffect(() => {
    GET("/career").then(setCareer).catch(() => {});
    GET("/courses").then(setCourses).catch(() => {});
    GET("/profile").then(setProfile).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    try { await PUT("/career", career); show("Career goals saved!"); }
    catch(e) { show(e.message, "error"); }
    setSaving(false);
  };

  const addMilestone = () => {
    setCareer(c => ({ ...c, milestones: [...(c.milestones || []), { id: Date.now().toString(), title: "", done: false }] }));
  };

  const updateMilestone = (id, data) => {
    setCareer(c => ({ ...c, milestones: c.milestones.map(m => m.id === id ? { ...m, ...data } : m) }));
  };

  const removeMilestone = (id) => {
    setCareer(c => ({ ...c, milestones: c.milestones.filter(m => m.id !== id) }));
  };

  const getAiAdvice = async () => {
    setAiLoading(true); setAiAdvice("");
    const completed = (profile?.progress || []).filter(p => p.percent >= 80).length;
    const enrolled = (profile?.enrolledCourses || []).length;
    try {
      // Runs on our server (which calls Claude) — the API key stays server-side.
      const data = await POST("/ai/career", { targetRole: career.targetRole || "Data Analyst", notes: career.notes, enrolled, completed, xp: profile?.xp || 0 });
      setAiAdvice(data.advice || "Unable to get advice.");
    } catch (e) { setAiAdvice("⚠️ " + (e.message || "Couldn't get AI advice right now.")); }
    setAiLoading(false);
  };

  const ROLES = ["Data Analyst", "Business Intelligence Analyst", "Data Scientist", "ML Engineer", "Analytics Manager", "Power BI Developer", "SQL Developer", "Python Developer"];

  const milestonesDone = (career.milestones || []).filter(m => m.done).length;
  const milestonesTotal = (career.milestones || []).length;

  return (
    <div className="fadeIn">
      {toastEl}
      <div className="section-header">
        <div>
          <h1 className="section-title">Career Roadmap</h1>
          <p style={{ color: "var(--text2)", fontSize: 13 }}>Define your goals and track your path to success</p>
        </div>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? <Spinner size={14} color="#fff" /> : <Ico n="cert" s={14} />}Save Goals
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Left — Goal Form */}
        <div>
          <div className="card-flat" style={{ padding: 24, marginBottom: 16 }}>
            <h3 style={{ fontWeight: 700, marginBottom: 18, fontSize: 15, color: "var(--text)" }}>🎯 Career Goal</h3>
            <div className="form-group">
              <label className="form-label">Target Role</label>
              <select className="input-field" value={career.targetRole || ""} onChange={e => setCareer(c => ({...c, targetRole: e.target.value}))}>
                <option value="">Select a role...</option>
                {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Target Date</label>
              <input type="date" className="input-field" value={career.targetDate || ""} onChange={e => setCareer(c => ({...c, targetDate: e.target.value}))} />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Notes & Motivation</label>
              <textarea className="input-field" rows={3} placeholder="What motivates you? What companies do you want to join?" value={career.notes || ""} onChange={e => setCareer(c => ({...c, notes: e.target.value}))} style={{ resize: "vertical" }} />
            </div>
          </div>

          {/* Milestones */}
          <div className="card-flat" style={{ padding: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ fontWeight: 700, fontSize: 15, color: "var(--text)" }}>📋 Milestones</h3>
              <button className="btn btn-secondary btn-xs" onClick={addMilestone}><Ico n="plus" s={12} />Add</button>
            </div>
            {milestonesTotal > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text2)", marginBottom: 6 }}>
                  <span>Progress</span><span>{milestonesDone}/{milestonesTotal}</span>
                </div>
                <ProgressBar value={milestonesTotal > 0 ? Math.round(milestonesDone/milestonesTotal*100) : 0} height={8} />
              </div>
            )}
            {(career.milestones || []).length === 0 ? (
              <div style={{ textAlign: "center", color: "var(--text2)", fontSize: 13, padding: "16px 0" }}>No milestones yet. Add your first goal!</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {(career.milestones || []).map(m => (
                  <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <button onClick={() => updateMilestone(m.id, { done: !m.done })} style={{ width: 20, height: 20, borderRadius: 5, border: `2px solid ${m.done ? B.success : "var(--input-border)"}`, background: m.done ? B.success : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "pointer" }}>
                      {m.done && <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 5l2.5 2.5 4.5-4.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round"/></svg>}
                    </button>
                    <input className="input-field" style={{ flex: 1, padding: "7px 10px", fontSize: 13, textDecoration: m.done ? "line-through" : "none" }} placeholder="e.g. Complete SQL course" value={m.title} onChange={e => updateMilestone(m.id, { title: e.target.value })} />
                    <button onClick={() => removeMilestone(m.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text2)" }}><Ico n="x" s={13} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right — AI Advisor */}
        <div>
          <div className="card-flat" style={{ padding: 24, marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
              <div>
                <h3 style={{ fontWeight: 700, fontSize: 15, color: "var(--text)" }}>🤖 AI Career Advisor</h3>
                <p style={{ fontSize: 12, color: "var(--text2)", marginTop: 3 }}>Get a personalized roadmap powered by Claude</p>
              </div>
              <button className="btn btn-primary btn-sm" onClick={getAiAdvice} disabled={aiLoading}>
                {aiLoading ? <Spinner size={13} color="#fff" /> : <Ico n="ai" s={13} />}{aiLoading ? "Thinking..." : "Get Advice"}
              </button>
            </div>
            {aiAdvice ? (
              <div style={{ background: "var(--surface2)", borderRadius: 12, padding: 16, fontSize: 13, lineHeight: 1.75, color: "var(--text)", whiteSpace: "pre-wrap", maxHeight: 340, overflowY: "auto" }}>{aiAdvice}</div>
            ) : (
              <div style={{ textAlign: "center", padding: "32px 16px", color: "var(--text2)" }}>
                <div style={{ fontSize: 40, marginBottom: 10 }}>🎓</div>
                <div style={{ fontSize: 13 }}>Set your target role above, then click "Get Advice" for a personalized career roadmap!</div>
              </div>
            )}
          </div>

          {/* Recommended Courses */}
          <div className="card-flat" style={{ padding: 24 }}>
            <h3 style={{ fontWeight: 700, fontSize: 15, color: "var(--text)", marginBottom: 14 }}>📚 Recommended for Your Goal</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {courses.slice(0, 4).map(c => (
                <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "var(--surface2)", borderRadius: 10, border: "1px solid var(--border)" }}>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: c.color, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{c.title}</div>
                    <div style={{ fontSize: 11, color: "var(--text2)" }}>{c.lessons} lessons · {c.duration}</div>
                  </div>
                  <span className="badge badge-orange">{c.category}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── ANALYTICS DASHBOARD (STUDENT) ────────────────────────────────────────────
const StudentAnalyticsPage = () => {
  const [profile, setProfile] = useState(null);
  const [courses, setCourses] = useState([]);
  const [board, setBoard] = useState([]);

  useEffect(() => {
    GET("/profile").then(setProfile).catch(() => {});
    GET("/courses").then(setCourses).catch(() => {});
    GET("/leaderboard").then(setBoard).catch(() => {});
  }, []);

  if (!profile) return <div style={{ padding: 60, textAlign: "center" }}><Spinner size={32} /></div>;

  const rank = board.findIndex(s => s.id === profile.id) + 1;
  const avgProgress = profile.progress?.length > 0 ? Math.round(profile.progress.reduce((a,p) => a+p.percent, 0) / profile.progress.length) : 0;
  const quizAvg = profile.quizResults?.length > 0 ? Math.round(profile.quizResults.reduce((a,r) => a+(r.score/r.total*100), 0) / profile.quizResults.length) : 0;

  const weekDays = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const weekActivity = weekDays.map((d, i) => ({ day: d, value: Math.random() > 0.3 ? Math.floor(Math.random()*3)+1 : 0 }));

  const Heatmap = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 4 }}>
        {weekDays.map((d, i) => (
          <div key={d} style={{ flex: 1, textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "var(--text2)", marginBottom: 4 }}>{d}</div>
            <div style={{ height: 28, borderRadius: 6, background: weekActivity[i].value > 0 ? `rgba(232,119,34,${0.3 + weekActivity[i].value * 0.2})` : "var(--surface2)", border: "1px solid var(--border)" }} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
        <span style={{ fontSize: 11, color: "var(--text2)" }}>Less</span>
        {[0.15, 0.35, 0.55, 0.75, 0.95].map(o => <div key={o} style={{ width: 14, height: 14, borderRadius: 3, background: `rgba(232,119,34,${o})` }} />)}
        <span style={{ fontSize: 11, color: "var(--text2)" }}>More</span>
      </div>
    </div>
  );

  return (
    <div className="fadeIn">
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: "var(--text)" }}>My Analytics</h1>
        <p style={{ color: "var(--text2)", fontSize: 13 }}>Your learning performance at a glance</p>
      </div>

      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <StatCard label="XP Earned" value={(profile.xp || 0).toLocaleString()} icon="zap" color={B.orange} />
        <StatCard label="Avg Progress" value={`${avgProgress}%`} icon="progress" color={B.navy} />
        <StatCard label="Quiz Avg" value={`${quizAvg}%`} icon="quiz" color="#10B981" />
        <StatCard label="Rank" value={rank > 0 ? `#${rank}` : "—"} icon="trophy" color="#F59E0B" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
        {/* Course Progress Chart */}
        <div className="card-flat" style={{ padding: 24 }}>
          <h3 style={{ fontWeight: 700, fontSize: 15, marginBottom: 18, color: "var(--text)" }}>Course Progress</h3>
          {(profile.progress || []).length === 0 ? (
            <div style={{ textAlign: "center", color: "var(--text2)", padding: 24 }}>No courses enrolled yet</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {(profile.progress || []).map(p => {
                const course = courses.find(c => c.id === p.courseId);
                return (
                  <div key={p.courseId}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 13 }}>
                      <span style={{ fontWeight: 600, color: "var(--text)" }}>{course?.title?.split(" ").slice(0,2).join(" ") || "Course"}</span>
                      <span style={{ fontWeight: 700, color: p.percent >= 80 ? B.success : B.orange }}>{p.percent}%</span>
                    </div>
                    <div style={{ height: 10, background: "var(--surface2)", borderRadius: 99, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${p.percent}%`, background: p.percent >= 80 ? `linear-gradient(90deg,${B.success},#16a34a)` : `linear-gradient(90deg,${B.orange},#f0a050)`, borderRadius: 99, transition: "width .6s" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Quiz Performance */}
        <div className="card-flat" style={{ padding: 24 }}>
          <h3 style={{ fontWeight: 700, fontSize: 15, marginBottom: 18, color: "var(--text)" }}>Quiz Performance</h3>
          {(profile.quizResults || []).length === 0 ? (
            <div style={{ textAlign: "center", color: "var(--text2)", padding: 24 }}>No quizzes taken yet</div>
          ) : (
            <div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 100, marginBottom: 12 }}>
                {(profile.quizResults || []).slice(-7).map((r, i) => {
                  const pct = Math.round(r.score/r.total*100);
                  return (
                    <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", gap: 4 }}>
                      <div style={{ fontSize: 10, color: "var(--text2)", fontWeight: 700 }}>{pct}%</div>
                      <div style={{ width: "100%", height: `${Math.max(12, pct)}%`, background: pct >= 70 ? `linear-gradient(180deg,${B.success},#16a34a)` : `linear-gradient(180deg,${B.danger},#dc2626)`, borderRadius: "4px 4px 0 0", minHeight: 8 }} />
                    </div>
                  );
                })}
              </div>
              <div style={{ textAlign: "center", fontSize: 12, color: "var(--text2)" }}>Last {Math.min(7, (profile.quizResults || []).length)} quizzes</div>
              <div style={{ marginTop: 12, padding: "8px 12px", background: quizAvg >= 70 ? `${B.success}15` : `${B.danger}15`, borderRadius: 8, textAlign: "center", fontSize: 13, fontWeight: 700, color: quizAvg >= 70 ? B.success : B.danger }}>
                Average: {quizAvg}% {quizAvg >= 70 ? "✓ Good" : "↑ Needs improvement"}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Activity Heatmap */}
      <div className="card-flat" style={{ padding: 24, marginBottom: 20 }}>
        <h3 style={{ fontWeight: 700, fontSize: 15, marginBottom: 18, color: "var(--text)" }}>Weekly Activity</h3>
        <Heatmap />
      </div>

      {/* Leaderboard Position */}
      {rank > 0 && (
        <div className="card-flat" style={{ padding: 24 }}>
          <h3 style={{ fontWeight: 700, fontSize: 15, marginBottom: 16, color: "var(--text)" }}>Your Position</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "16px 20px", background: `${B.orange}10`, borderRadius: 12, border: `1.5px solid ${B.orange}40` }}>
            <div style={{ fontSize: 32, fontWeight: 900, color: B.orange, minWidth: 48, textAlign: "center" }}>#{rank}</div>
            <div>
              <div style={{ fontWeight: 700, color: "var(--text)", fontSize: 15 }}>{profile.name}</div>
              <div style={{ fontSize: 13, color: "var(--text2)" }}>{profile.xp?.toLocaleString()} XP · 🔥 {profile.streak} day streak · 🏅 {profile.badges} badges</div>
            </div>
            {rank <= 3 && <div style={{ marginLeft: "auto", fontSize: 28 }}>{["🥇","🥈","🥉"][rank-1]}</div>}
          </div>
          <div style={{ marginTop: 12, fontSize: 12, color: "var(--text2)", textAlign: "center" }}>
            {board.length > 0 && rank < board.length && `${board.length - rank} students behind you · `}
            Keep learning to climb the leaderboard!
          </div>
        </div>
      )}
    </div>
  );
};

// ─── PROFILE DROPDOWN ──────────────────────────────────────────────────────────
const ProfileDropdown = ({ user, onLogout, onClose }) => {
  const { dark, toggle } = useTheme();
  return (
    <div className="dropdown" style={{ top: 64, right: 16, width: 220 }} onClick={e => e.stopPropagation()}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)" }}>{user.name}</div>
        <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 2 }}>{user.email}</div>
        <span className={`badge badge-${user.role === "superadmin" ? "purple" : user.role === "admin" ? "orange" : user.role === "authority" ? "yellow" : "navy"}`} style={{ marginTop: 6, display: "inline-block" }}>{user.role}</span>
      </div>
      <div style={{ padding: "6px 0" }}>
        <div className="dropdown-item" onClick={toggle}>
          <Ico n={dark ? "sun" : "moon"} s={16} c="var(--text2)" />
          {dark ? "Light Mode" : "Dark Mode"}
        </div>
        <div className="dropdown-item" style={{ color: B.danger }} onClick={() => { onLogout(); onClose(); }}>
          <Ico n="logout" s={16} c={B.danger} />Sign Out
        </div>
      </div>
    </div>
  );
};

// ─── ADMIN PROJECTS ────────────────────────────────────────────────────────────
const AdminProjectsPage = ({ batches, courses }) => {
  const [projects, setProjects] = useState([]);
  const [students, setStudents] = useState([]);
  const [modal, setModal] = useState(false);
  const blankProject = { title: "", topic: "", description: "", assignType: "student", studentId: "", batchId: "", courseId: "", maxMarks: 100, fileData: null, fileName: null, fileType: null };
  const [form, setForm] = useState(blankProject);
  const [grade, setGrade] = useState({}); // `${pid}_${sid}` -> { marks, feedback }
  const [show, toastEl] = useToast();
  const onProjFile = e => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { show("File too large (max 5MB)", "error"); return; }
    const reader = new FileReader();
    reader.onload = ev => setForm(f => ({ ...f, fileData: ev.target.result, fileName: file.name, fileType: file.type }));
    reader.readAsDataURL(file);
  };

  const load = () => GET("/projects").then(setProjects).catch(() => {});
  useEffect(() => { load(); GET("/students").then(setStudents).catch(() => {}); }, []);

  const create = async () => {
    if (!form.title.trim()) { show("Enter a project title", "error"); return; }
    if (form.assignType === "student" && !form.studentId) { show("Pick a student", "error"); return; }
    if (form.assignType === "batch" && !form.batchId) { show("Pick a batch", "error"); return; }
    try {
      await POST("/projects", { ...form, maxMarks: Number(form.maxMarks) || 100 });
      show("Project assigned"); setModal(false);
      setForm(blankProject);
      load();
    } catch (e) { show(e.message, "error"); }
  };
  const setG = (key, patch) => setGrade(m => ({ ...m, [key]: { ...m[key], ...patch } }));
  const gradeRow = async (p, row) => {
    const key = `${p.id}_${row.studentId}`; const g = grade[key] || {};
    const marks = g.marks !== undefined ? g.marks : (row.marks ?? "");
    if (marks === "" || isNaN(Number(marks))) { show("Enter marks", "error"); return; }
    try {
      await POST(`/projects/${p.id}/grade`, { studentId: row.studentId, marks: Number(marks), feedback: g.feedback !== undefined ? g.feedback : row.feedback });
      show(`${row.studentName}: ${marks}/${p.maxMarks} — ${marks} XP set`); load();
    } catch (e) { show(e.message, "error"); }
  };
  const del = async (p) => {
    if (!confirm(`Delete project "${p.title}"? Any XP it awarded is removed.`)) return;
    try { await DELETE(`/projects/${p.id}`); show("Project deleted"); load(); }
    catch (e) { show(e.message, "error"); }
  };

  return (
    <div className="fadeIn">
      {toastEl}
      <div className="section-header">
        <div><h1 className="section-title">Projects</h1><p style={{ color: "var(--text2)", fontSize: 13 }}>{projects.length} projects assigned</p></div>
        <button className="btn btn-primary" onClick={() => setModal(true)}><Ico n="plus" s={15} />Assign Project</button>
      </div>
      {projects.length === 0 ? <EmptyState icon="assign" title="No projects yet" desc="Assign a project to one student or a whole batch." action={<button className="btn btn-primary" onClick={() => setModal(true)}>Assign Project</button>} /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {projects.map(p => (
            <div key={p.id} className="card" style={{ padding: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 10 }}>
                <div>
                  <div style={{ fontWeight: 700, color: "var(--text)", fontSize: 15 }}>{p.title}</div>
                  <div style={{ fontSize: 12.5, color: "var(--text2)", marginTop: 3 }}>{p.topic ? `Topic: ${p.topic} · ` : ""}Max {p.maxMarks} · {p.assignType === "student" ? `Student: ${p.assigneeName}` : `Batch: ${p.assigneeName}`}</div>
                </div>
                <button className="btn btn-danger btn-xs" onClick={() => del(p)}><Ico n="trash" s={12} /></button>
              </div>
              {p.description && <div style={{ fontSize: 13, color: "var(--text2)", marginBottom: 12, whiteSpace: "pre-wrap" }}>{p.description}</div>}
              {p.hasFile && (
                <button className="btn btn-secondary btn-sm" style={{ marginBottom: 12 }}
                  onClick={() => openStoredFile(`/projects/${p.id}/file`, p.fileName || "brief").catch(() => show("Could not open the file", "error"))}>
                  <Ico n="assign" s={13} />Attached brief{p.fileName ? `: ${p.fileName}` : ""}
                </button>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {p.rows.length === 0 ? <div style={{ fontSize: 12, color: "var(--text2)" }}>No students in this batch yet.</div> : p.rows.map(row => {
                  const key = `${p.id}_${row.studentId}`; const g = grade[key] || {};
                  const marksVal = g.marks !== undefined ? g.marks : (row.marks ?? "");
                  const fbVal = g.feedback !== undefined ? g.feedback : row.feedback;
                  return (
                    <div key={row.studentId} style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px" }}>
                      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                        <div style={{ minWidth: 150 }}>
                          <div style={{ fontWeight: 600, color: "var(--text)", fontSize: 13.5 }}>{row.studentName}</div>
                          <div style={{ fontSize: 11.5, color: row.gradedAt ? B.success : row.submittedAt ? B.navy : "var(--text2)" }}>{row.submittedAt ? (row.gradedAt ? `Graded: ${row.marks}/${p.maxMarks}` : "Submitted — awaiting grade") : "Not submitted yet"}</div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <input className="input-field" type="number" min="0" max={p.maxMarks} placeholder="Marks" style={{ width: 78, padding: "6px 8px", fontSize: 13 }} value={marksVal} onChange={e => setG(key, { marks: e.target.value })} />
                          <span style={{ fontSize: 12, color: "var(--text2)" }}>/ {p.maxMarks}</span>
                          <button className="btn btn-primary btn-sm" onClick={() => gradeRow(p, row)}>{row.gradedAt ? "Update" : "Grade"}</button>
                        </div>
                      </div>
                      {row.link && <div style={{ fontSize: 12, marginTop: 6 }}><a href={row.link} target="_blank" rel="noreferrer" style={{ color: B.orange }}>🔗 {row.link}</a></div>}
                      {row.hasSubmissionFile && (
                        <button className="btn btn-secondary btn-sm" style={{ marginTop: 6 }}
                          onClick={() => openStoredFile(`/projects/${p.id}/submission-file?studentId=${row.studentId}`, row.submissionFileName || "submission").catch(() => show("Could not open the file", "error"))}>
                          <Ico n="download" s={13} />View submitted file{row.submissionFileName ? `: ${row.submissionFileName}` : ""}
                        </button>
                      )}
                      {row.note && <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 4, whiteSpace: "pre-wrap" }}>📝 {row.note}</div>}
                      <input className="input-field" placeholder="Feedback (optional)" style={{ marginTop: 6, fontSize: 12.5, padding: "6px 10px" }} value={fbVal} onChange={e => setG(key, { feedback: e.target.value })} />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      {modal && (
        <Modal title="Assign Project" onClose={() => setModal(false)}>
          <div className="form-group"><label className="form-label">Project Title</label><input className="input-field" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g. Sales Dashboard in Power BI" /></div>
          <div className="form-group"><label className="form-label">Topic <span style={{ color: "var(--text2)", fontWeight: 500 }}>(each student can get a different one)</span></label><input className="input-field" value={form.topic} onChange={e => setForm({ ...form, topic: e.target.value })} placeholder="e.g. Superstore sales analysis" /></div>
          <div className="form-group"><label className="form-label">Description / instructions</label><textarea className="input-field" rows={3} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} style={{ resize: "vertical" }} /></div>
          <div className="form-group">
            <label className="form-label">Assign to</label>
            <div className="tab-bar">
              <button className={`tab ${form.assignType === "student" ? "active" : ""}`} style={{ flex: 1, justifyContent: "center" }} onClick={() => setForm({ ...form, assignType: "student" })}>One student</button>
              <button className={`tab ${form.assignType === "batch" ? "active" : ""}`} style={{ flex: 1, justifyContent: "center" }} onClick={() => setForm({ ...form, assignType: "batch" })}>Whole batch</button>
            </div>
          </div>
          {form.assignType === "student" ? (
            <div className="form-group"><label className="form-label">Student</label>
              <select className="input-field" value={form.studentId} onChange={e => setForm({ ...form, studentId: e.target.value })}>
                <option value="">— Select student —</option>
                {students.map(s => <option key={s.id} value={s.id}>{s.name} ({s.email})</option>)}
              </select>
            </div>
          ) : (
            <div className="form-group"><label className="form-label">Batch <span style={{ color: "var(--text2)", fontWeight: 500 }}>(all students in it get this project)</span></label>
              <select className="input-field" value={form.batchId} onChange={e => setForm({ ...form, batchId: e.target.value })}>
                <option value="">— Select batch —</option>
                {(batches || []).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="form-group"><label className="form-label">Course (optional)</label>
              <select className="input-field" value={form.courseId} onChange={e => setForm({ ...form, courseId: e.target.value })}>
                <option value="">— None —</option>
                {(courses || []).map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </div>
            <div className="form-group"><label className="form-label">Max Marks</label><input className="input-field" type="number" min="1" value={form.maxMarks} onChange={e => setForm({ ...form, maxMarks: e.target.value })} /></div>
          </div>
          <div className="form-group">
            <label className="form-label">Attach a file <span style={{ color: "var(--text2)", fontWeight: 500 }}>(optional — brief, dataset or template · PDF/doc/image, max 5MB)</span></label>
            {form.fileName ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10, border: `1.5px solid ${B.success}55`, background: `${B.success}10` }}>
                <Ico n="check" s={16} c={B.success} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{form.fileName}</span>
                <button type="button" onClick={() => setForm(f => ({ ...f, fileData: null, fileName: null, fileType: null }))} style={{ background: "none", border: "none", color: B.danger, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>Remove</button>
              </div>
            ) : (
              <input type="file" onChange={onProjFile} className="input-field" style={{ padding: 8 }} />
            )}
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <button className="btn btn-primary" style={{ flex: 1, justifyContent: "center" }} onClick={create}>Assign Project</button>
            <button className="btn btn-secondary" onClick={() => { setModal(false); setForm(blankProject); }}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
};

// ─── STUDENT PROJECTS ──────────────────────────────────────────────────────────
const StudentProjectsPage = () => {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [inputs, setInputs] = useState({}); // pid -> { link, note }
  const [show, toastEl] = useToast();

  const load = () => GET("/my-projects").then(setProjects).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const setI = (id, patch) => setInputs(m => ({ ...m, [id]: { ...m[id], ...patch } }));
  const onSubFile = (id, e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { show("File too large (max 5MB)", "error"); return; }
    const reader = new FileReader();
    reader.onload = ev => setI(id, { fileData: ev.target.result, fileName: file.name, fileType: file.type });
    reader.readAsDataURL(file);
  };
  const submit = async (p) => {
    const v = inputs[p.id] || {};
    const link = v.link !== undefined ? v.link : p.link;
    const note = v.note !== undefined ? v.note : p.note;
    if (!link && !note && !v.fileData && !p.hasSubmissionFile) { show("Add a link, a note, or attach a file", "error"); return; }
    try {
      await POST(`/projects/${p.id}/submit`, { link, note, fileData: v.fileData, fileName: v.fileName, fileType: v.fileType });
      show("Submitted ✓"); setI(p.id, { fileData: undefined, fileName: undefined, fileType: undefined }); load();
    } catch (e) { show(e.message, "error"); }
  };

  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner size={32} /></div>;

  return (
    <div className="fadeIn">
      {toastEl}
      <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 6, color: "var(--text)" }}>My Projects</h1>
      <p style={{ color: "var(--text2)", fontSize: 13, marginBottom: 20 }}>Projects your admin assigned to you. Submit a link and/or attach your work file to get graded and earn XP.</p>
      {projects.length === 0 ? <EmptyState icon="assign" title="No projects yet" desc="Your admin will assign projects here." /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {projects.map(p => {
            const v = inputs[p.id] || {};
            const linkVal = v.link !== undefined ? v.link : p.link;
            const noteVal = v.note !== undefined ? v.note : p.note;
            const sc = p.status === "graded" ? B.success : p.status === "submitted" ? B.navy : B.orange;
            const sl = p.status === "graded" ? "Graded" : p.status === "submitted" ? "Submitted" : "To do";
            return (
              <div key={p.id} className="card-flat" style={{ padding: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                  <div>
                    <div style={{ fontWeight: 700, color: "var(--text)", fontSize: 16 }}>{p.title}</div>
                    <div style={{ fontSize: 12.5, color: "var(--text2)", marginTop: 3 }}>{p.topic ? `Topic: ${p.topic} · ` : ""}Max {p.maxMarks} marks{p.courseTitle ? ` · ${p.courseTitle}` : ""} · by {p.adminName}</div>
                  </div>
                  <span className="badge" style={{ background: `${sc}20`, color: sc }}>{sl}</span>
                </div>
                {p.description && <div style={{ fontSize: 13.5, color: "var(--text)", marginTop: 10, whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{p.description}</div>}
                {p.hasFile && (
                  <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }}
                    onClick={() => openStoredFile(`/projects/${p.id}/file`, p.fileName || "brief").catch(() => show("Could not open the file", "error"))}>
                    <Ico n="assign" s={13} />View project brief{p.fileName ? `: ${p.fileName}` : ""}
                  </button>
                )}
                {p.status === "graded" ? (
                  <div style={{ marginTop: 14, background: `${B.success}12`, border: `1px solid ${B.success}44`, borderRadius: 10, padding: 14 }}>
                    <div style={{ fontSize: 22, fontWeight: 900, color: B.success }}>{p.marks}/{p.maxMarks}</div>
                    <div style={{ fontSize: 13, color: "var(--text)", marginTop: 2 }}>+{p.marks} XP earned 🎉</div>
                    {p.feedback && <div style={{ fontSize: 13, color: "var(--text2)", marginTop: 8 }}><b>Feedback:</b> {p.feedback}</div>}
                    {p.link && <div style={{ fontSize: 12, marginTop: 8 }}>Your submission: <a href={p.link} target="_blank" rel="noreferrer" style={{ color: B.orange }}>{p.link}</a></div>}
                    {p.hasSubmissionFile && <div style={{ fontSize: 12, marginTop: 6 }}><button className="btn btn-secondary btn-xs" onClick={() => openStoredFile(`/projects/${p.id}/submission-file`, p.submissionFileName || "submission").catch(() => show("Could not open", "error"))}><Ico n="download" s={12} />Your file{p.submissionFileName ? `: ${p.submissionFileName}` : ""}</button></div>}
                  </div>
                ) : (
                  <div style={{ marginTop: 14 }}>
                    <div className="form-group"><label className="form-label">Submission link (GitHub / Drive / etc.)</label><input className="input-field" placeholder="https://..." value={linkVal} onChange={e => setI(p.id, { link: e.target.value })} /></div>
                    <div className="form-group">
                      <label className="form-label">Attach your work <span style={{ color: "var(--text2)", fontWeight: 500 }}>(optional — PDF/doc/zip/image, max 5MB)</span></label>
                      {v.fileName ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10, border: `1.5px solid ${B.success}55`, background: `${B.success}10` }}>
                          <Ico n="check" s={16} c={B.success} />
                          <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.fileName}</span>
                          <button type="button" onClick={() => setI(p.id, { fileData: undefined, fileName: undefined, fileType: undefined })} style={{ background: "none", border: "none", color: B.danger, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>Remove</button>
                        </div>
                      ) : (
                        <input type="file" onChange={e => onSubFile(p.id, e)} className="input-field" style={{ padding: 8 }} />
                      )}
                      {!v.fileName && p.hasSubmissionFile && <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 6 }}>Attached: {p.submissionFileName || "your file"} — <button className="btn-ghost" style={{ padding: 0, fontSize: 12, color: B.orange, fontWeight: 600 }} onClick={() => openStoredFile(`/projects/${p.id}/submission-file`, p.submissionFileName || "submission").catch(() => {})}>view</button>. Choose a new file to replace it.</div>}
                    </div>
                    <div className="form-group"><label className="form-label">Note (optional)</label><textarea className="input-field" rows={2} placeholder="Anything you want your admin to know" value={noteVal} onChange={e => setI(p.id, { note: e.target.value })} style={{ resize: "vertical" }} /></div>
                    <button className="btn btn-primary" onClick={() => submit(p)}><Ico n="send" s={14} />{p.status === "submitted" ? "Re-submit" : "Submit"}</button>
                    {p.status === "submitted" && <span style={{ fontSize: 12, color: "var(--text2)", marginLeft: 10 }}>Submitted — you can update it until it's graded.</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ─── MAIN APP ──────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState("landing");
  const [user, setUser] = useState(null);
  const [studentId, setStudentId] = useState(null);
  const [page, setPage] = useState("dashboard");
  const [openCourseId, setOpenCourseId] = useState(null);
  const [batches, setBatches] = useState([]);
  const [courses, setCourses] = useState([]);
  const [notifs, setNotifs] = useState([]);
  const [showNotifs, setShowNotifs] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dark, setDark] = useState(() => localStorage.getItem("lms_dark") === "1");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const toggleDark = () => setDark(d => { const v = !d; localStorage.setItem("lms_dark", v ? "1" : "0"); return v; });

  // Auto-login
  useEffect(() => {
    const token = getToken();
    if (!token) { setLoading(false); return; }
    GET("/auth/me").then(u => {
      setUser({ ...u, adminId: u.adminId, subject: u.subject });
      setStudentId(u.studentId);
      setScreen("app");
    }).catch(() => { clearToken(); }).finally(() => setLoading(false));
  }, []);

  // Anti-cheat: a quiz guard can force the student back to the login screen.
  useEffect(() => {
    const onForce = () => { clearToken(); setUser(null); setStudentId(null); setPage("dashboard"); setScreen("auth"); };
    window.addEventListener("lms-force-logout", onForce);
    return () => window.removeEventListener("lms-force-logout", onForce);
  }, []);

  useEffect(() => {
    if (screen === "app") {
      GET("/batches").then(setBatches);
      GET("/courses").then(setCourses);
      GET("/notifications").then(setNotifs);
    }
  }, [screen]);

  // Live notifications: poll every 20s so alerts (e.g. quiz cheating) appear without a reload.
  useEffect(() => {
    if (screen !== "app") return;
    const t = setInterval(() => { GET("/notifications").then(setNotifs).catch(() => {}); }, 20000);
    return () => clearInterval(t);
  }, [screen]);

  const goPage = id => { setPage(id); setSidebarOpen(false); setShowNotifs(false); setShowProfile(false); };
  const openCourse = id => { setOpenCourseId(id); goPage("courses"); };
  const handleLogin = (u, sid, aid, subj) => { setUser({ ...u, adminId: aid, subject: subj }); setStudentId(sid); setPage("dashboard"); setScreen("app"); };
  const handleLogout = () => { clearToken(); setUser(null); setScreen("landing"); setPage("dashboard"); };

  const unread = notifs.filter(n => !n.read).length;

  const NAV_SUPER = [
    { id: "dashboard", label: "Dashboard", icon: "home" },
    { id: "admins", label: "Manage Admins", icon: "users" },
    { id: "authorities", label: "Authorities", icon: "shield" },
    { id: "students", label: "All Students", icon: "user" },
    { id: "courses", label: "All Courses", icon: "book" },
    { id: "projects", label: "Projects", icon: "assign" },
    { id: "quiz", label: "Quizzes", icon: "quiz" },
    { id: "assign", label: "Materials", icon: "book" },
    { id: "forum", label: "Forum", icon: "forum" },
    { id: "leaderboard", label: "Leaderboard", icon: "trophy" },
    { id: "settings", label: "Settings", icon: "settings" },
  ];
  const NAV_ADMIN = [
    { id: "dashboard", label: "Dashboard", icon: "home" },
    { id: "students", label: "My Students", icon: "users" },
    { id: "courses", label: "My Courses", icon: "book" },
    { id: "projects", label: "Projects", icon: "assign" },
    { id: "quiz", label: "Quizzes", icon: "quiz" },
    { id: "assign", label: "Materials", icon: "book" },
    { id: "forum", label: "Forum", icon: "forum" },
    { id: "leaderboard", label: "Leaderboard", icon: "trophy" },
    { id: "settings", label: "Settings", icon: "settings" },
  ];
  const NAV_STUDENT = [
    { id: "dashboard", label: "Dashboard", icon: "home" },
    { id: "courses", label: "My Courses", icon: "book" },
    { id: "projects", label: "My Projects", icon: "assign" },
    { id: "quiz", label: "Quizzes", icon: "quiz" },
    { id: "code", label: "Playground", icon: "code" },
    { id: "ai", label: "AI Tutor", icon: "ai" },
    { id: "planner", label: "Study Planner", icon: "flame" },
    { id: "career", label: "Career Roadmap", icon: "trophy" },
    { id: "analytics", label: "My Analytics", icon: "chart" },
    { id: "assign", label: "Materials", icon: "book" },
    { id: "forum", label: "Forum", icon: "forum" },
    { id: "leaderboard", label: "Leaderboard", icon: "zap" },
    { id: "progress", label: "My Progress", icon: "progress" },
    { id: "cert", label: "Certificates", icon: "cert" },
  ];

  const NAV_AUTHORITY = [
    { id: "dashboard", label: "Batch Report", icon: "chart" },
  ];
  const nav = user?.role === "superadmin" ? NAV_SUPER : user?.role === "admin" ? NAV_ADMIN : user?.role === "authority" ? NAV_AUTHORITY : NAV_STUDENT;

  // ── Global top-bar search: jump to any sidebar section or course ──
  const isStudentRole = !["superadmin", "admin", "authority"].includes(user?.role);
  const searchTerm = searchQuery.trim().toLowerCase();
  const searchResults = searchTerm ? [
    ...nav.filter(n => n.label.toLowerCase().includes(searchTerm))
         .map(n => ({ key: "p-" + n.id, type: "page", id: n.id, label: n.label, icon: n.icon, sub: "Section" })),
    ...courses.filter(c => (c.title || "").toLowerCase().includes(searchTerm) || (c.category || "").toLowerCase().includes(searchTerm))
         .map(c => ({ key: "c-" + c.id, type: "course", id: c.id, label: c.title, icon: "book", sub: c.category || "Course" })),
  ].slice(0, 8) : [];
  const goSearchResult = res => {
    if (!res) return;
    if (res.type === "course") { if (isStudentRole) openCourse(res.id); else goPage("courses"); }
    else goPage(res.id);
    setSearchQuery(""); setSearchOpen(false);
  };

  const BOTTOM_SUPER = [{ id: "dashboard", icon: "home", label: "Home" }, { id: "admins", icon: "users", label: "Admins" }, { id: "courses", icon: "book", label: "Courses" }, { id: "students", icon: "user", label: "Students" }, { id: "settings", icon: "settings", label: "Settings" }];
  const BOTTOM_ADMIN = [{ id: "dashboard", icon: "home", label: "Home" }, { id: "students", icon: "users", label: "Students" }, { id: "courses", icon: "book", label: "Courses" }, { id: "quiz", icon: "quiz", label: "Quizzes" }, { id: "settings", icon: "settings", label: "Settings" }];
  const BOTTOM_STUDENT = [{ id: "dashboard", icon: "home", label: "Home" }, { id: "courses", icon: "book", label: "Courses" }, { id: "ai", icon: "ai", label: "AI Tutor" }, { id: "planner", icon: "flame", label: "Planner" }, { id: "analytics", icon: "chart", label: "Analytics" }];
  const BOTTOM_AUTHORITY = [{ id: "dashboard", icon: "chart", label: "Report" }];
  const bottomNav = user?.role === "superadmin" ? BOTTOM_SUPER : user?.role === "admin" ? BOTTOM_ADMIN : user?.role === "authority" ? BOTTOM_AUTHORITY : BOTTOM_STUDENT;

  const renderPage = () => {
    if (user?.role === "superadmin") {
      if (page === "dashboard") return <SuperAdminDashboard />;
      if (page === "admins") return <SuperAdminManagePage />;
      if (page === "authorities") return <SuperAuthoritiesPage />;
      if (page === "students") return <AdminStudentsPage batches={batches} courses={courses} />;
      if (page === "courses") return <AdminCoursesPage user={user} onCourseChange={() => GET("/courses").then(setCourses)} />;
      if (page === "projects") return <AdminProjectsPage batches={batches} courses={courses} />;
      if (page === "quiz") return <AdminQuizPage />;
      if (page === "assign") return <AssignmentsPage user={user} />;
      if (page === "forum") return <ForumPage user={user} />;
      if (page === "leaderboard") return <LeaderboardPage />;
      if (page === "settings") return <AdminSettingsPage />;
    }
    if (user?.role === "admin") {
      if (page === "dashboard") return <AdminDashboard />;
      if (page === "students") return <AdminStudentsPage batches={batches} courses={courses} />;
      if (page === "courses") return <AdminCoursesPage user={user} onCourseChange={() => GET("/courses").then(setCourses)} />;
      if (page === "projects") return <AdminProjectsPage batches={batches} courses={courses} />;
      if (page === "quiz") return <AdminQuizPage />;
      if (page === "assign") return <AssignmentsPage user={user} />;
      if (page === "forum") return <ForumPage user={user} />;
      if (page === "leaderboard") return <LeaderboardPage />;
      if (page === "settings") return <AdminSettingsPage />;
    }
    // Authority (read-only batch monitor)
    if (user?.role === "authority") return <AuthorityPage />;
    // Student
    if (page === "dashboard") return <StudentDashboard user={user} studentId={studentId} onOpenCourse={openCourse} />;
    if (page === "courses") return <StudentCoursesPage openCourseId={openCourseId} onConsumeOpen={() => setOpenCourseId(null)} />;
    if (page === "projects") return <StudentProjectsPage />;
    if (page === "quiz") return <StudentQuizPage />;
    if (page === "code") return <CodingPage />;
    if (page === "ai") return <AITutorPage />;
    if (page === "planner") return <StudyPlannerPage />;
    if (page === "career") return <CareerPage />;
    if (page === "analytics") return <StudentAnalyticsPage />;
    if (page === "assign") return <AssignmentsPage user={user} />;
    if (page === "forum") return <ForumPage user={user} />;
    if (page === "leaderboard") return <LeaderboardPage />;
    if (page === "progress") return <ProgressPage />;
    if (page === "cert") return <CertificatesPage user={user} />;
    return <StudentDashboard user={user} studentId={studentId} onOpenCourse={openCourse} />;
  };

  if (loading) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(150deg,#0D2137,#17406E)" }}>
      <div style={{ textAlign: "center", color: "#fff" }}>
        <div style={{ background: "rgba(255,255,255,.1)", borderRadius: 16, padding: "14px 20px", display: "inline-block", marginBottom: 28, backdropFilter: "blur(8px)" }}>
          <img src="/dhishaai-logo.png" alt="DhishaAI" style={{ width: 180, height: "auto", display: "block" }} />
        </div>
        <br />
        <Spinner size={40} />
        <div style={{ marginTop: 16, fontWeight: 600, opacity: .6, fontSize: 14 }}>Loading your learning platform...</div>
      </div>
    </div>
  );

  return (
    <ThemeCtx.Provider value={{ dark, toggle: toggleDark }}>
      <GlobalStyle dark={dark} />
      {screen === "landing" && <LandingPage onGetStarted={() => setScreen("auth")} />}
      {screen === "auth" && <AuthPage onLogin={handleLogin} onBack={() => setScreen("landing")} />}
      {screen === "app" && (
        <div onClick={() => { if (showNotifs) setShowNotifs(false); if (showProfile) setShowProfile(false); }}>
          {/* Sidebar overlay */}
          <div className={`sidebar-overlay ${sidebarOpen ? "" : "hidden"}`} onClick={() => setSidebarOpen(false)} />

          {/* Sidebar */}
          <div className={`sidebar ${sidebarOpen ? "open" : ""}`}>
            <div style={{ padding: "4px 4px 18px" }}>
              <div style={{ background: "#fff", borderRadius: 12, padding: "10px 12px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <img src="/dhishaai-logo.png" alt="DhishaAI" style={{ height: 34, width: "auto", maxWidth: "100%", objectFit: "contain", display: "block" }} />
              </div>
              <div style={{ marginTop: 10, padding: "4px 10px", borderRadius: 8, fontSize: 10, fontWeight: 700, letterSpacing: .8, textTransform: "uppercase", textAlign: "center", color: user?.role === "superadmin" ? "#C4B5FD" : user?.role === "admin" ? B.orange : "rgba(255,255,255,.5)", background: user?.role === "superadmin" ? "rgba(124,58,237,.2)" : user?.role === "admin" ? "rgba(232,119,34,.15)" : "rgba(255,255,255,.08)", border: `1px solid ${user?.role === "superadmin" ? "rgba(124,58,237,.3)" : user?.role === "admin" ? "rgba(232,119,34,.25)" : "rgba(255,255,255,.12)"}` }}>
                {user?.role === "superadmin" ? "Super Admin" : user?.role === "admin" ? (user?.subject || "Admin") : user?.role === "authority" ? "Authority" : "Student"}
              </div>
            </div>

            {nav.map(item => (
              <div key={item.id} className={`sidebar-item ${page === item.id ? "active" : ""}`} style={{ flexShrink: 0 }} onClick={() => goPage(item.id)}>
                <Ico n={item.icon} s={17} />{item.label}
              </div>
            ))}

            {/* Sidebar user */}
            <div style={{ borderTop: "1px solid rgba(255,255,255,.08)", paddingTop: 12, marginTop: "auto", flexShrink: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderRadius: 10, marginBottom: 4 }}>
                <div style={{ width: 34, height: 34, borderRadius: 9, background: "rgba(255,255,255,.12)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, color: "#fff", fontSize: 14, flexShrink: 0 }}>{user?.name?.[0]}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user?.name}</div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,.45)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user?.email}</div>
                </div>
              </div>
              <div className="sidebar-item" onClick={handleLogout} style={{ color: "rgba(255,100,100,.7)" }}>
                <Ico n="logout" s={17} />Sign Out
              </div>
            </div>
          </div>

          {/* Main */}
          <div className="main-layout">
            {/* Top Bar */}
            <div className="top-bar">
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <button className="hamburger" onClick={() => setSidebarOpen(v => !v)}>
                  <Ico n="menu" s={22} c="var(--text)" />
                </button>
                <div style={{ position: "relative" }}>
                  <div className="top-bar-search">
                    <Ico n="search" s={15} c="var(--text2)" />
                    <input placeholder="Search sections & courses..." value={searchQuery}
                      onChange={e => { setSearchQuery(e.target.value); setSearchOpen(true); }}
                      onFocus={() => setSearchOpen(true)}
                      onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
                      onKeyDown={e => {
                        if (e.key === "Enter") goSearchResult(searchResults[0]);
                        else if (e.key === "Escape") { setSearchQuery(""); setSearchOpen(false); e.currentTarget.blur(); }
                      }} />
                  </div>
                  {searchOpen && searchTerm && (
                    <div className="dropdown" style={{ top: "calc(100% + 6px)", left: 0, minWidth: 280, maxWidth: 340, maxHeight: 360, overflowY: "auto" }}>
                      {searchResults.length === 0 ? (
                        <div style={{ padding: "12px 16px", fontSize: 13, color: "var(--text2)" }}>No matches for “{searchQuery}”</div>
                      ) : searchResults.map(res => (
                        <div key={res.key} className="dropdown-item" onMouseDown={e => e.preventDefault()} onClick={() => goSearchResult(res)}>
                          <Ico n={res.icon} s={16} c="var(--text2)" />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 13.5, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{res.label}</div>
                            <div style={{ fontSize: 11, color: "var(--text2)" }}>{res.sub}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                {/* Dark mode toggle */}
                <button className="btn-ghost" style={{ borderRadius: 9, padding: 8, position: "relative" }} onClick={e => { e.stopPropagation(); toggleDark(); }}>
                  <Ico n={dark ? "sun" : "moon"} s={18} c="var(--text2)" />
                </button>

                {/* Notifications */}
                <button className="btn-ghost" style={{ borderRadius: 9, padding: 8, position: "relative" }} onClick={e => { e.stopPropagation(); setShowNotifs(v => !v); setShowProfile(false); }}>
                  <Ico n="bell" s={18} c="var(--text2)" />
                  {unread > 0 && <span className="notif-dot">{unread}</span>}
                </button>

                {/* Profile — avatar only on mobile, name on desktop */}
                <button className="btn-ghost" style={{ borderRadius: 9, padding: 5, display: "flex", alignItems: "center", gap: 7, position: "relative" }} onClick={e => { e.stopPropagation(); setShowProfile(v => !v); setShowNotifs(false); }}>
                  <div style={{ width: 34, height: 34, borderRadius: 9, background: `linear-gradient(135deg,${B.navy},#1a4d8a)`, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, color: "#fff", fontSize: 14, flexShrink: 0 }}>{user?.name?.[0]}</div>
                  <div className="topbar-name" style={{ lineHeight: 1.3, textAlign: "left" }}>
                    <div style={{ fontSize: 13, fontWeight: 700, maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>{user?.name?.split(" ")[0]}</div>
                    <div style={{ fontSize: 10, color: "var(--text2)", textTransform: "capitalize" }}>{user?.role}</div>
                  </div>
                  <span className="topbar-chevron"><Ico n="chevron" s={14} c="var(--text2)" /></span>
                </button>
              </div>
            </div>

            {/* Dropdowns */}
            {showNotifs && <div onClick={e => e.stopPropagation()}><NotificationsPanel onClose={() => setShowNotifs(false)} /></div>}
            {showProfile && <div onClick={e => e.stopPropagation()}><ProfileDropdown user={user} onLogout={handleLogout} onClose={() => setShowProfile(false)} /></div>}

            {/* Page Content */}
            <div className="page-content">{renderPage()}</div>
          </div>

          {/* Bottom Nav */}
          <nav className="bottom-nav">
            <div className="bottom-nav-items">
              {bottomNav.map(item => (
                <button key={item.id} className={`bottom-nav-item ${page === item.id ? "active" : ""}`} onClick={() => goPage(item.id)}>
                  <Ico n={item.icon} s={20} c={page === item.id ? B.orange : "var(--text2)"} />
                  {item.label}
                </button>
              ))}
            </div>
          </nav>
        </div>
      )}
    </ThemeCtx.Provider>
  );
}
