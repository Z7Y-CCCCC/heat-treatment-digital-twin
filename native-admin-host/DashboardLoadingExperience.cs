namespace HeatTreatmentAdminHost;

internal static class DashboardLoadingExperience
{
    public const string DocumentCreatedScript = """
        (() => {
          if (window.location.pathname !== '/overlay' && window.location.pathname !== '/group') return;
          window.__DIGITAL_TWIN_NATIVE_LOADING__ = true;
          if (window.__DIGITAL_TWIN_LOADING_ROOT__) return;

          const style = document.createElement('style');
          style.textContent = `
            #digital-twin-loading-root{position:fixed;z-index:2147483647;inset:0;display:grid;place-items:center;overflow:hidden;padding:30px;background:var(--dtl-background,#f5f7fb);color:#1d2939;font-family:Inter,"Noto Sans SC","Segoe UI","Microsoft YaHei UI",sans-serif;-webkit-font-smoothing:antialiased;pointer-events:none;opacity:1;transition:opacity .18s ease}
            #digital-twin-loading-root *{box-sizing:border-box}
            #digital-twin-loading-root.is-leaving{opacity:0}
            #digital-twin-loading-root .dtl-atmosphere{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 38%,rgba(87,139,247,.06),transparent 52%),linear-gradient(135deg,#f8fbff,transparent 48%,#eef3fc)}
            #digital-twin-loading-root .dtl-card{position:relative;width:min(900px,92vw);padding:27px 34px 24px;border:1px solid #dbe4f2;border-radius:13px;background:#ffffff;box-shadow:0 12px 36px rgba(42,72,125,.07)}
            #digital-twin-loading-root .dtl-heading{display:flex;align-items:center;gap:11px;color:#54709a}
            #digital-twin-loading-root .dtl-mark{display:flex;align-items:flex-end;gap:3px;width:18px;height:18px;padding:3px;border:1px solid #d3e0f7;border-radius:5px}
            #digital-twin-loading-root .dtl-mark i{width:3px;border-radius:2px;background:#2563eb}#digital-twin-loading-root .dtl-mark i:nth-child(1){height:5px}#digital-twin-loading-root .dtl-mark i:nth-child(2){height:9px}#digital-twin-loading-root .dtl-mark i:nth-child(3){height:7px;background:#76a2ff}
            #digital-twin-loading-root .dtl-kicker{font-size:9px;font-weight:600;letter-spacing:.17em}#digital-twin-loading-root .dtl-kicker i{padding:0 5px;color:#98a7bf;font-style:normal}
            #digital-twin-loading-root .dtl-live{display:flex;align-items:center;gap:7px;margin-left:auto;color:#71819b;font-size:8px;letter-spacing:.12em}#digital-twin-loading-root .dtl-live i,#digital-twin-loading-root .dtl-caption i{width:5px;height:5px;border-radius:50%;background:#2563eb;box-shadow:none;animation:dtl-pulse 1.8s ease-in-out infinite}
            #digital-twin-loading-root .dtl-art{position:relative;display:grid;place-items:center;height:clamp(190px,30vw,310px);margin:12px 0 4px;overflow:hidden;border-bottom:1px solid #edf1f8}
            #digital-twin-loading-root .dtl-art:before{position:absolute;inset:0;content:"";background:linear-gradient(90deg,rgba(255,255,255,.7),transparent 24%,transparent 76%,rgba(255,255,255,.7)),linear-gradient(0deg,#f5f7fb 0%,transparent 23%,transparent 84%,rgba(255,255,255,.4));pointer-events:none}
            #digital-twin-loading-root .dtl-glow{position:absolute;bottom:13%;width:52%;height:13%;border-radius:50%;background:radial-gradient(ellipse,rgba(93,139,222,.12),transparent 70%)}
            #digital-twin-loading-root .dtl-model{position:relative;z-index:2;display:grid;place-items:center;width:min(77%,720px);height:100%;touch-action:none;user-select:none;-webkit-user-select:none;cursor:grab;pointer-events:auto;transform:perspective(950px) rotateX(var(--dtl-tilt-x,0deg)) rotateY(var(--dtl-tilt-y,0deg)) scale(var(--dtl-scale,1));transform-style:preserve-3d;transition:transform .22s cubic-bezier(.2,.75,.25,1);will-change:transform}
            #digital-twin-loading-root .dtl-model.is-dragging{cursor:grabbing;transition:none}
            #digital-twin-loading-root .dtl-model-stage{position:relative;width:auto;height:100%;max-width:100%;aspect-ratio:3/2;animation:dtl-float 5s ease-in-out infinite}
            #digital-twin-loading-root .dtl-model-stage>img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none}
            #digital-twin-loading-root [data-loading-effect]{position:absolute;z-index:2;display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:50%;background:transparent;transform:translate(-50%,-50%);cursor:pointer;pointer-events:auto}
            #digital-twin-loading-root [data-loading-effect]:focus-visible{outline:1px solid rgba(255,255,255,.85);outline-offset:1px}
            #digital-twin-loading-root [data-loading-effect] i{display:block;width:7px;height:7px;border:1px solid rgba(255,255,255,.72);border-radius:50%;background:#81e5d5;box-shadow:0 0 8px 3px rgba(70,220,202,.65);animation:dtl-lamp-breathe 2.4s ease-in-out infinite}
            #digital-twin-loading-root [data-loading-effect="lamp"][data-tone="amber"] i{background:#ffd18d;box-shadow:0 0 8px 3px rgba(255,161,58,.65);animation-delay:.7s}
            #digital-twin-loading-root [data-loading-effect="lamp"].off i{opacity:.16;box-shadow:none;animation:none}
            #digital-twin-loading-root [data-loading-effect="smoke"] i{width:8px;height:8px;border-color:rgba(226,236,235,.6);background:rgba(218,227,227,.45);box-shadow:0 0 8px rgba(190,210,210,.4)}
            #digital-twin-loading-root [data-loading-effect="furnace"] i{width:10px;height:10px;border-color:rgba(255,208,143,.7);background:rgba(255,163,64,.85);box-shadow:0 0 12px 5px rgba(255,144,44,.4);animation:dtl-fire-breathe 1.8s ease-in-out infinite}
            #digital-twin-loading-root [data-loading-effect="furnace"].off i{opacity:.12;box-shadow:none;animation:none}
            #digital-twin-loading-root .dtl-smoke{position:absolute;z-index:1;width:10px;height:18px;pointer-events:none;transform:translate(-50%,-100%);transition:opacity .25s ease}
            #digital-twin-loading-root .dtl-smoke:before,#digital-twin-loading-root .dtl-smoke:after{position:absolute;bottom:0;left:50%;width:6px;height:9px;border-radius:50%;background:rgba(220,226,225,.42);filter:blur(2px);content:"";animation:dtl-smoke-rise 2.8s ease-out infinite}
            #digital-twin-loading-root .dtl-smoke:after{animation-delay:1.4s}#digital-twin-loading-root .dtl-smoke.off{opacity:0}
            #digital-twin-loading-root .dtl-caption,#digital-twin-loading-root .dtl-index{position:absolute;z-index:2;bottom:13px;color:#71819b;font-size:8px;letter-spacing:.12em;pointer-events:none}#digital-twin-loading-root .dtl-caption{left:1px;display:flex;align-items:center;gap:8px}#digital-twin-loading-root .dtl-caption b{color:#54709a;font-weight:500}#digital-twin-loading-root .dtl-index{right:1px;color:#71819b;font-size:7px}
            #digital-twin-loading-root .dtl-status{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:14px 1px 13px}#digital-twin-loading-root .dtl-status h1{margin:0;color:#1d2939;font-size:17px;font-weight:500;letter-spacing:.025em}#digital-twin-loading-root .dtl-status p{margin:6px 0 0;color:#667085;font-size:11px}#digital-twin-loading-root .dtl-percent{color:#2563eb;font-size:22px;font-weight:400;font-variant-numeric:tabular-nums}#digital-twin-loading-root .dtl-percent small{margin-left:2px;color:#71819b;font-size:10px}
            #digital-twin-loading-root .dtl-track{position:relative;height:3px;overflow:hidden;border-radius:99px;background:#e5edfb}#digital-twin-loading-root .dtl-fill{position:absolute;inset:0;border-radius:inherit;background:var(--dtl-accent,#2563eb);transform:scaleX(.08);transform-origin:left;transition:transform .18s ease-out}
            #digital-twin-loading-root.is-quiet [data-loading-effect],#digital-twin-loading-root.is-quiet .dtl-smoke,#digital-twin-loading-root.is-quiet .dtl-index,#digital-twin-loading-root.is-custom-artwork [data-loading-effect],#digital-twin-loading-root.is-custom-artwork .dtl-smoke{display:none}#digital-twin-loading-root.is-quiet .dtl-model-stage{animation:none}
            #digital-twin-loading-root .dtl-phases{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:18px 0 0;padding:0;list-style:none}#digital-twin-loading-root .dtl-phases li{display:flex;align-items:center;gap:9px;min-width:0;color:#98a7bf}#digital-twin-loading-root .dtl-marker{display:grid;place-items:center;width:19px;height:19px;flex:0 0 19px;border:1px solid #dbe4f2;border-radius:50%}#digital-twin-loading-root .dtl-marker i{width:4px;height:4px;border-radius:50%;background:#98a7bf}#digital-twin-loading-root .dtl-copy{display:grid;gap:3px;min-width:0}#digital-twin-loading-root .dtl-copy strong{overflow:hidden;color:#71819b;font-size:9px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}#digital-twin-loading-root .dtl-copy small{overflow:hidden;color:#71819b;font-size:7px;letter-spacing:.08em;text-overflow:ellipsis;white-space:nowrap}
            #digital-twin-loading-root li.complete .dtl-marker{border-color:#b9cef7;background:#edf3ff}#digital-twin-loading-root li.complete .dtl-marker i,#digital-twin-loading-root li.current .dtl-marker i{background:#2563eb}#digital-twin-loading-root li.complete .dtl-copy strong{color:#315b9f}#digital-twin-loading-root li.current .dtl-marker{border-color:#2563eb;box-shadow:none}#digital-twin-loading-root li.current .dtl-marker i{background:#2563eb;box-shadow:none}#digital-twin-loading-root li.current .dtl-copy strong{color:#2563eb}
            #digital-twin-loading-root .dtl-footer{position:absolute;bottom:23px;left:50%;display:flex;align-items:center;gap:10px;transform:translateX(-50%);color:#71819b;font-size:8px;letter-spacing:.06em;white-space:nowrap}#digital-twin-loading-root .dtl-footer i{width:2px;height:2px;border-radius:50%;background:#9dbaf3}
            @keyframes dtl-float{0%,100%{transform:translateY(2px)}50%{transform:translateY(-5px)}}@keyframes dtl-pulse{50%{opacity:.42}}@keyframes dtl-lamp-breathe{0%,100%{opacity:.62;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}}@keyframes dtl-fire-breathe{0%,100%{opacity:.75;transform:scale(.8)}45%{opacity:1;transform:scale(1.25)}}@keyframes dtl-smoke-rise{0%{opacity:0;transform:translate(-50%,3px) scale(.45)}22%{opacity:.7}100%{opacity:0;transform:translate(30%,-36px) scale(1.9)}}
            @media(max-width:640px){#digital-twin-loading-root{padding:14px}#digital-twin-loading-root .dtl-card{width:100%;padding:20px 18px 18px}#digital-twin-loading-root .dtl-art{height:clamp(160px,45vw,235px)}#digital-twin-loading-root .dtl-phases{gap:5px}#digital-twin-loading-root .dtl-phases li{gap:5px}#digital-twin-loading-root .dtl-marker{width:15px;height:15px;flex-basis:15px}#digital-twin-loading-root .dtl-copy strong{font-size:8px}#digital-twin-loading-root .dtl-copy small{font-size:6px}#digital-twin-loading-root .dtl-live{font-size:7px}#digital-twin-loading-root .dtl-footer{bottom:10px;font-size:7px}}
            @media(prefers-reduced-motion:reduce){#digital-twin-loading-root,#digital-twin-loading-root .dtl-fill{transition:none}#digital-twin-loading-root .dtl-model-stage,#digital-twin-loading-root .dtl-live i,#digital-twin-loading-root [data-loading-effect] i,#digital-twin-loading-root .dtl-smoke:before,#digital-twin-loading-root .dtl-smoke:after{animation:none}}
            #digital-twin-loading-root.is-dark{background:var(--dtl-background,#28282b);color:#e8e8e4}
            #digital-twin-loading-root.is-dark .dtl-atmosphere{background:radial-gradient(ellipse at 50% 38%,rgba(166,169,156,.1),transparent 52%),linear-gradient(135deg,rgba(255,255,255,.018),transparent 48%,rgba(0,0,0,.11))}
            #digital-twin-loading-root.is-dark .dtl-card{border:1px solid rgba(206,207,195,.13);background:linear-gradient(145deg,rgba(49,49,52,.97),rgba(38,38,41,.98))}
            #digital-twin-loading-root.is-dark .dtl-heading{color:#b8b9b2}
            #digital-twin-loading-root.is-dark .dtl-mark{border:1px solid rgba(204,209,195,.28)}
            #digital-twin-loading-root.is-dark .dtl-mark i{background:#a9c3b5}
            #digital-twin-loading-root.is-dark .dtl-mark i:nth-child(3){background:#d2a66c}
            #digital-twin-loading-root.is-dark .dtl-kicker i{color:#777871}
            #digital-twin-loading-root.is-dark .dtl-live{color:#92938d}
            #digital-twin-loading-root.is-dark .dtl-live i,#digital-twin-loading-root.is-dark .dtl-caption i{background:#91b4a3}
            #digital-twin-loading-root.is-dark .dtl-art:before{background:linear-gradient(90deg,rgba(39,39,42,.68),transparent 24%,transparent 76%,rgba(39,39,42,.68)),linear-gradient(0deg,#29292c 0%,transparent 23%,transparent 84%,rgba(41,41,44,.4))}
            #digital-twin-loading-root.is-dark .dtl-glow{background:rgba(200,202,185,.12)}
            #digital-twin-loading-root.is-dark [data-loading-effect]{border:0;background:transparent}
            #digital-twin-loading-root.is-dark [data-loading-effect]:focus-visible{outline:1px solid rgba(255,255,255,.85)}
            #digital-twin-loading-root.is-dark [data-loading-effect] i{border:1px solid rgba(255,255,255,.72);background:#81e5d5}
            #digital-twin-loading-root.is-dark [data-loading-effect="lamp"][data-tone="amber"] i{background:#ffd18d}
            #digital-twin-loading-root.is-dark [data-loading-effect="smoke"] i{border-color:rgba(226,236,235,.6);background:rgba(218,227,227,.45)}
            #digital-twin-loading-root.is-dark [data-loading-effect="furnace"] i{border-color:rgba(255,208,143,.7);background:rgba(255,163,64,.85)}
            #digital-twin-loading-root.is-dark .dtl-smoke:before,#digital-twin-loading-root.is-dark .dtl-smoke:after{background:rgba(220,226,225,.42)}
            #digital-twin-loading-root.is-dark .dtl-caption,#digital-twin-loading-root.is-dark .dtl-index{color:#8c8d87}
            #digital-twin-loading-root.is-dark .dtl-caption b{color:#b7b8b0}
            #digital-twin-loading-root.is-dark .dtl-index{color:#878880}
            #digital-twin-loading-root.is-dark .dtl-status h1{color:#eeeeea}
            #digital-twin-loading-root.is-dark .dtl-status p{color:#9c9d96}
            #digital-twin-loading-root.is-dark .dtl-percent{color:#d6d7cf}
            #digital-twin-loading-root.is-dark .dtl-percent small{color:#96978f}
            #digital-twin-loading-root.is-dark .dtl-track{background:rgba(220,221,210,.12)}
            #digital-twin-loading-root.is-dark .dtl-fill{background:var(--dtl-accent,#a8c3b1)}
            #digital-twin-loading-root.is-dark .dtl-knob{border:2px solid #28282b;background:#cfb07e}
            #digital-twin-loading-root.is-dark .dtl-phases li{color:#767770}
            #digital-twin-loading-root.is-dark .dtl-marker{border:1px solid rgba(203,204,193,.17)}
            #digital-twin-loading-root.is-dark .dtl-marker i{background:#777871}
            #digital-twin-loading-root.is-dark .dtl-copy strong{color:#85867f}
            #digital-twin-loading-root.is-dark .dtl-copy small{color:#656660}
            #digital-twin-loading-root.is-dark li.complete .dtl-marker{border-color:rgba(143,179,158,.55);background:rgba(143,179,158,.1)}
            #digital-twin-loading-root.is-dark li.complete .dtl-marker i,#digital-twin-loading-root.is-dark li.current .dtl-marker i{background:#a8c3b1}
            #digital-twin-loading-root.is-dark li.complete .dtl-copy strong{color:#b1c4b5}
            #digital-twin-loading-root.is-dark li.current .dtl-marker{border-color:rgba(201,174,130,.6)}
            #digital-twin-loading-root.is-dark li.current .dtl-marker i{background:#d1b17d}
            #digital-twin-loading-root.is-dark li.current .dtl-copy strong{color:#e1d1b1}
            #digital-twin-loading-root.is-dark .dtl-footer{color:#7f8079}
            #digital-twin-loading-root.is-dark .dtl-footer i{background:#b99c71}
          `;

          let finished = false;
          const root = document.createElement('div');
          root.id = 'digital-twin-loading-root';
          const appearanceCacheKey = 'digital_twin_loading_appearance_v1';
          let appearanceCache = {}, themeRevision = 0;
          try { appearanceCache = JSON.parse(localStorage.getItem(appearanceCacheKey) || '{}') || {}; } catch {}
          function applyTheme(theme) {
            const dark = theme === 'dark';
            root.classList.toggle('is-dark', dark);
            root.style.setProperty('--dtl-background', dark ? '#28282b' : '#f5f7fb');
            root.style.setProperty('--dtl-accent', dark ? '#a8c3b1' : '#2563eb');
            appearanceCache = { ...appearanceCache, theme: dark ? 'dark' : 'light', background: dark ? '#28282b' : '#f5f7fb', accent: dark ? '#a8c3b1' : '#2563eb' };
            try { localStorage.setItem(appearanceCacheKey, JSON.stringify(appearanceCache)); } catch {}
          }
          applyTheme(window.__DIGITAL_TWIN_WINDOW_THEME__ || appearanceCache.theme);
          function themeChanged(event) {
            if (!['light','dark'].includes(event.detail)) return;
            themeRevision++;
            applyTheme(event.detail);
          }
          window.addEventListener('digital-twin-loading-theme', themeChanged);
          root.setAttribute('role', 'status');
          root.setAttribute('aria-live', 'polite');
          root.innerHTML = `
            <div class="dtl-atmosphere" aria-hidden="true"></div>
            <main class="dtl-card">
              <header class="dtl-heading"><span class="dtl-mark" aria-hidden="true"><i></i><i></i><i></i></span><span class="dtl-kicker">HEAT TREATMENT <i>/</i> DIGITAL TWIN</span><span class="dtl-live"><i></i> SYSTEM STARTUP</span></header>
              <div class="dtl-art"><div class="dtl-glow"></div><div class="dtl-model" aria-label="拖动旋转厂房示意图，滚轮缩放，双击复位"><div class="dtl-model-stage"><img src="/loading/industrial-factory.png" alt="" draggable="false"/><span class="dtl-smoke" data-smoke-index="0" style="left:26%;top:47.6%"></span><span class="dtl-smoke" data-smoke-index="1" style="left:60.5%;top:37%"></span><button type="button" data-loading-effect="lamp" data-tone="cyan" style="left:5.6%;top:53.2%" aria-label="入口状态灯，点击切换" aria-pressed="true" title="入口状态灯 · 点击开关"><i></i></button><button type="button" data-loading-effect="lamp" data-tone="cyan" style="left:18.7%;top:65%" aria-label="输送线状态灯，点击切换" aria-pressed="true" title="输送线状态灯 · 点击开关"><i></i></button><button type="button" data-loading-effect="lamp" data-tone="cyan" style="left:44.6%;top:56.8%" aria-label="热处理设备状态灯，点击切换" aria-pressed="true" title="热处理设备状态灯 · 点击开关"><i></i></button><button type="button" data-loading-effect="lamp" data-tone="cyan" style="left:61.6%;top:53.9%" aria-label="中段设备状态灯，点击切换" aria-pressed="true" title="中段设备状态灯 · 点击开关"><i></i></button><button type="button" data-loading-effect="lamp" data-tone="amber" style="left:76.8%;top:48.9%" aria-label="炉体指示灯，点击切换" aria-pressed="true" title="炉体指示灯 · 点击开关"><i></i></button><button type="button" data-loading-effect="lamp" data-tone="amber" style="left:87.8%;top:42.2%" aria-label="末端设备状态灯，点击切换" aria-pressed="true" title="末端设备状态灯 · 点击开关"><i></i></button><button type="button" data-loading-effect="smoke" data-smoke-index="0" style="left:26%;top:47.6%" aria-label="前段排气烟囱，点击切换排烟" aria-pressed="true" title="前段排气烟囱 · 点击切换排烟"><i></i></button><button type="button" data-loading-effect="smoke" data-smoke-index="1" style="left:60.5%;top:37%" aria-label="主排气烟囱，点击切换排烟" aria-pressed="true" title="主排气烟囱 · 点击切换排烟"><i></i></button><button type="button" data-loading-effect="furnace" style="left:27.3%;top:71.3%" aria-label="入口加热炉，点击点火或熄火" aria-pressed="true" title="入口加热炉 · 点击点火或熄火"><i></i></button><button type="button" data-loading-effect="furnace" style="left:71.6%;top:49.4%" aria-label="主加热炉，点击点火或熄火" aria-pressed="true" title="主加热炉 · 点击点火或熄火"><i></i></button></div></div><span class="dtl-caption"><i></i> FACTORY SYSTEMS <b>INITIALIZING</b></span><span class="dtl-index">拖动旋转 · 滚轮缩放 · 点击设备互动</span></div>
              <div class="dtl-status"><div><h1>正在准备生产现场</h1><p class="dtl-step">正在读取现场配置</p></div><strong class="dtl-percent"><span>8</span><small>%</small></strong></div>
              <div class="dtl-track"><i class="dtl-fill"></i></div>
              <ol class="dtl-phases"><li class="current"><span class="dtl-marker"><i></i></span><span class="dtl-copy"><strong>现场配置</strong><small>CONFIGURATION</small></span></li><li><span class="dtl-marker"><i></i></span><span class="dtl-copy"><strong>三维场景</strong><small>3D SCENE</small></span></li><li><span class="dtl-marker"><i></i></span><span class="dtl-copy"><strong>设备模型</strong><small>EQUIPMENT</small></span></li><li><span class="dtl-marker"><i></i></span><span class="dtl-copy"><strong>实时数据</strong><small>LIVE DATA</small></span></li></ol>
            </main>
            <footer class="dtl-footer"><span>PRODUCTION OPERATIONS</span><i></i><span>请稍候，正在同步现场状态</span></footer>`;

          const mount = () => {
            if (!document.documentElement) return false;
            if (!style.isConnected) document.documentElement.appendChild(style);
            if (!root.isConnected) document.documentElement.appendChild(root);
            return true;
          };
          const model = root.querySelector('.dtl-model');
          let modelPointer = null;
          let modelTiltX = 0;
          let modelTiltY = 0;
          let modelScale = 1;
          let modelFrame = 0;
          const updateModel = () => {
            if (modelFrame || finished) return;
            modelFrame = requestAnimationFrame(() => {
              modelFrame = 0;
            model.style.setProperty('--dtl-tilt-x', modelTiltX + 'deg');
            model.style.setProperty('--dtl-tilt-y', modelTiltY + 'deg');
            model.style.setProperty('--dtl-scale', modelScale);
            });
          };
          const stopModelDrag = () => {
            modelPointer = null;
            model.classList.remove('is-dragging');
          };
          model.addEventListener('pointerdown', event => {
            if (event.target.closest('[data-loading-effect]')) return;
            if (event.button !== 0) return;
            modelPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
            model.classList.add('is-dragging');
            model.setPointerCapture(event.pointerId);
            event.preventDefault();
          });
          model.addEventListener('pointermove', event => {
            if (!modelPointer || modelPointer.id !== event.pointerId) return;
            const dx = event.clientX - modelPointer.x;
            const dy = event.clientY - modelPointer.y;
            modelPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
            modelTiltY = Math.max(-42, Math.min(42, modelTiltY + dx * .34));
            modelTiltX = Math.max(-22, Math.min(22, modelTiltX - dy * .25));
            updateModel();
          });
          model.addEventListener('pointerup', stopModelDrag);
          model.addEventListener('pointercancel', stopModelDrag);
          model.addEventListener('lostpointercapture', stopModelDrag);
          model.addEventListener('click', event => {
            const control = event.target.closest('[data-loading-effect]');
            if (!control) return;
            const isOff = control.classList.toggle('off');
            control.setAttribute('aria-pressed', String(!isOff));
            const smokeIndex = control.dataset.smokeIndex;
            if (smokeIndex !== undefined) model.querySelector(`.dtl-smoke[data-smoke-index="${smokeIndex}"]`)?.classList.toggle('off', isOff);
          });
          model.addEventListener('wheel', event => {
            event.preventDefault();
            modelScale = Math.max(.88, Math.min(1.22, modelScale - Math.sign(event.deltaY) * .06));
            updateModel();
          }, { passive: false });
          model.addEventListener('dblclick', event => {
            if (event.target.closest('[data-loading-effect]')) return;
            event.preventDefault();
            modelTiltX = 0;
            modelTiltY = 0;
            modelScale = 1;
            updateModel();
          });
          if (!mount()) document.addEventListener('DOMContentLoaded', mount, { once: true });
          window.__DIGITAL_TWIN_LOADING_ROOT__ = root;

          const requestedThemeRevision = themeRevision;
          fetch('/api/settings/loading-experience', { credentials: 'same-origin', cache: 'no-store' })
            .then(response => response.ok ? response.json() : null)
            .then(data => {
              const config = data?.config;
              if (finished || !config || typeof config !== 'object') return;
              if (requestedThemeRevision === themeRevision) applyTheme(config.theme || (['#28282b','#29292c'].includes(config.background?.toLowerCase()) ? 'dark' : 'light'));
              if (typeof config.title === 'string' && config.title.trim()) root.querySelector('.dtl-status h1').textContent = config.title.slice(0, 48);
              if (typeof config.kicker === 'string' && config.kicker.trim()) root.querySelector('.dtl-kicker').textContent = config.kicker.slice(0, 72);
              if (typeof config.imageUrl === 'string' && /^\/uploads\/appearance\/[a-f0-9]{32}\.(?:png|jpg|webp)$/.test(config.imageUrl)) {
                root.querySelector('.dtl-model-stage>img').src = config.imageUrl;
                root.classList.add('is-custom-artwork');
              }
              root.classList.toggle('is-quiet', config.preset === 'quiet');
            }).catch(() => {});

          const phases = ['正在读取现场配置', '正在构建三维场景', '正在装配设备模型', '正在连接实时数据'];
          const fill = root.querySelector('.dtl-fill');
          const percent = root.querySelector('.dtl-percent span');
          const stepLabel = root.querySelector('.dtl-step');
          const phaseItems = [...root.querySelectorAll('.dtl-phases li')];
          let lastProgress = -1, lastPhase = -1, lastStep = '';
          const setProgress = (value, phase, step) => {
            const number = Number(value);
            const progress = Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
            const current = Math.max(0, Math.min(3, Math.trunc(Number.isFinite(Number(phase)) ? Number(phase) : progress / 25)));
            if (lastProgress !== progress) {
              fill.style.transform = 'scaleX(' + progress / 100 + ')';
              percent.textContent = Math.round(progress);
              lastProgress = progress;
            }
            const text = step || phases[current];
            if (lastStep !== text) { stepLabel.textContent = text; lastStep = text; }
            if (lastPhase !== current) {
              phaseItems.forEach((item, index) => {
                item.classList.toggle('complete', index < current);
                item.classList.toggle('current', index === current);
              });
              lastPhase = current;
            }
          };
          let progressFrame = 0, pendingProgress = null;
          window.__DIGITAL_TWIN_LOADING_PROGRESS__ = detail => {
            if (finished) return;
            pendingProgress = detail;
            if (progressFrame) return;
            progressFrame = requestAnimationFrame(() => {
              progressFrame = 0;
              setProgress(pendingProgress?.progress, pendingProgress?.phase, pendingProgress?.step);
            });
          };
          const onProgress = event => window.__DIGITAL_TWIN_LOADING_PROGRESS__(event.detail);
          window.addEventListener('digital-twin-loading-progress', onProgress);
          window.__DIGITAL_TWIN_FINISH_LOADING__ = () => {
            if (finished) return;
            finished = true;
            cancelAnimationFrame(progressFrame);
            cancelAnimationFrame(modelFrame);
            window.removeEventListener('digital-twin-loading-progress', onProgress);
            window.removeEventListener('digital-twin-loading-theme', themeChanged);
            setProgress(100, 3, '生产现场已就绪');
            root.classList.add('is-leaving');
            window.setTimeout(() => {
              root.remove(); style.remove(); window.__DIGITAL_TWIN_LOADING_ROOT__ = null;
              // Release the artwork/DOM closure while the dashboard stays open.
              window.__DIGITAL_TWIN_LOADING_PROGRESS__ = null;
              window.__DIGITAL_TWIN_FINISH_LOADING__ = null;
            }, 200);
          };
          // Progress comes from real configuration/model/data milestones. Do not
          // wake the UI every 140ms or overwrite actual progress with a timer.

        })();
        """;
}
