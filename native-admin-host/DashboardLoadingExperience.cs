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
            #digital-twin-loading-root{position:fixed;z-index:2147483647;inset:0;display:grid;place-items:center;overflow:hidden;padding:30px;background:#28282b;color:#e8e8e4;font-family:Inter,"Noto Sans SC","Segoe UI","Microsoft YaHei UI",sans-serif;-webkit-font-smoothing:antialiased;pointer-events:none;opacity:1;transition:opacity .42s ease}
            #digital-twin-loading-root *{box-sizing:border-box}
            #digital-twin-loading-root.is-leaving{opacity:0}
            #digital-twin-loading-root .dtl-atmosphere{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 38%,rgba(166,169,156,.1),transparent 52%),linear-gradient(135deg,rgba(255,255,255,.018),transparent 48%,rgba(0,0,0,.11))}
            #digital-twin-loading-root .dtl-card{position:relative;width:min(900px,92vw);padding:27px 34px 24px;border:1px solid rgba(206,207,195,.13);border-radius:13px;background:linear-gradient(145deg,rgba(49,49,52,.97),rgba(38,38,41,.98));box-shadow:0 34px 100px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.045)}
            #digital-twin-loading-root .dtl-heading{display:flex;align-items:center;gap:11px;color:#b8b9b2}
            #digital-twin-loading-root .dtl-mark{display:flex;align-items:flex-end;gap:3px;width:18px;height:18px;padding:3px;border:1px solid rgba(204,209,195,.28);border-radius:5px}
            #digital-twin-loading-root .dtl-mark i{width:3px;border-radius:2px;background:#a9c3b5}#digital-twin-loading-root .dtl-mark i:nth-child(1){height:5px}#digital-twin-loading-root .dtl-mark i:nth-child(2){height:9px}#digital-twin-loading-root .dtl-mark i:nth-child(3){height:7px;background:#d2a66c}
            #digital-twin-loading-root .dtl-kicker{font-size:9px;font-weight:600;letter-spacing:.17em}#digital-twin-loading-root .dtl-kicker i{padding:0 5px;color:#777871;font-style:normal}
            #digital-twin-loading-root .dtl-live{display:flex;align-items:center;gap:7px;margin-left:auto;color:#92938d;font-size:8px;letter-spacing:.12em}#digital-twin-loading-root .dtl-live i,#digital-twin-loading-root .dtl-caption i{width:5px;height:5px;border-radius:50%;background:#91b4a3;box-shadow:0 0 9px rgba(145,180,163,.46);animation:dtl-pulse 1.8s ease-in-out infinite}
            #digital-twin-loading-root .dtl-art{position:relative;display:grid;place-items:center;height:clamp(190px,30vw,310px);margin:12px 0 4px;overflow:hidden;border-bottom:1px solid rgba(202,205,192,.1)}
            #digital-twin-loading-root .dtl-art:before{position:absolute;inset:0;content:"";background:linear-gradient(90deg,rgba(39,39,42,.68),transparent 24%,transparent 76%,rgba(39,39,42,.68)),linear-gradient(0deg,#29292c 0%,transparent 23%,transparent 84%,rgba(41,41,44,.4));pointer-events:none}
            #digital-twin-loading-root .dtl-glow{position:absolute;bottom:13%;width:52%;height:13%;border-radius:50%;background:rgba(200,202,185,.12);filter:blur(34px)}
            #digital-twin-loading-root .dtl-model{position:relative;z-index:2;display:grid;place-items:center;width:min(77%,720px);height:100%;touch-action:none;user-select:none;-webkit-user-select:none;cursor:grab;pointer-events:auto;transform:perspective(950px) rotateX(var(--dtl-tilt-x,0deg)) rotateY(var(--dtl-tilt-y,0deg)) scale(var(--dtl-scale,1));transform-style:preserve-3d;transition:transform .22s cubic-bezier(.2,.75,.25,1);will-change:transform}
            #digital-twin-loading-root .dtl-model.is-dragging{cursor:grabbing;transition:none}
            #digital-twin-loading-root .dtl-model-stage{position:relative;width:auto;height:100%;max-width:100%;aspect-ratio:3/2;animation:dtl-float 5s ease-in-out infinite}
            #digital-twin-loading-root .dtl-model-stage>img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 20px 30px rgba(0,0,0,.15));pointer-events:none}
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
            #digital-twin-loading-root .dtl-caption,#digital-twin-loading-root .dtl-index{position:absolute;z-index:2;bottom:13px;color:#8c8d87;font-size:8px;letter-spacing:.12em;pointer-events:none}#digital-twin-loading-root .dtl-caption{left:1px;display:flex;align-items:center;gap:8px}#digital-twin-loading-root .dtl-caption b{color:#b7b8b0;font-weight:500}#digital-twin-loading-root .dtl-index{right:1px;color:#878880;font-size:7px}
            #digital-twin-loading-root .dtl-status{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:14px 1px 13px}#digital-twin-loading-root .dtl-status h1{margin:0;color:#eeeeea;font-size:17px;font-weight:500;letter-spacing:.025em}#digital-twin-loading-root .dtl-status p{margin:6px 0 0;color:#9c9d96;font-size:11px}#digital-twin-loading-root .dtl-percent{color:#d6d7cf;font-size:22px;font-weight:400;font-variant-numeric:tabular-nums}#digital-twin-loading-root .dtl-percent small{margin-left:2px;color:#96978f;font-size:10px}
            #digital-twin-loading-root .dtl-track{position:relative;height:3px;border-radius:99px;background:rgba(220,221,210,.12)}#digital-twin-loading-root .dtl-fill{position:absolute;inset:0 auto 0 0;width:8%;border-radius:inherit;background:linear-gradient(90deg,#7d9a8a,#b4c8b5 72%,#d0ad7a);transition:width .55s cubic-bezier(.22,.75,.3,1)}#digital-twin-loading-root .dtl-knob{position:absolute;top:50%;left:8%;width:9px;height:9px;border:2px solid #28282b;border-radius:50%;background:#cfb07e;box-shadow:0 0 12px rgba(207,176,126,.45);transform:translate(-50%,-50%);transition:left .55s cubic-bezier(.22,.75,.3,1)}
            #digital-twin-loading-root .dtl-phases{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:18px 0 0;padding:0;list-style:none}#digital-twin-loading-root .dtl-phases li{display:flex;align-items:center;gap:9px;min-width:0;color:#767770}#digital-twin-loading-root .dtl-marker{display:grid;place-items:center;width:19px;height:19px;flex:0 0 19px;border:1px solid rgba(203,204,193,.17);border-radius:50%}#digital-twin-loading-root .dtl-marker i{width:4px;height:4px;border-radius:50%;background:#777871}#digital-twin-loading-root .dtl-copy{display:grid;gap:3px;min-width:0}#digital-twin-loading-root .dtl-copy strong{overflow:hidden;color:#85867f;font-size:9px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}#digital-twin-loading-root .dtl-copy small{overflow:hidden;color:#656660;font-size:7px;letter-spacing:.08em;text-overflow:ellipsis;white-space:nowrap}
            #digital-twin-loading-root li.complete .dtl-marker{border-color:rgba(143,179,158,.55);background:rgba(143,179,158,.1)}#digital-twin-loading-root li.complete .dtl-marker i,#digital-twin-loading-root li.current .dtl-marker i{background:#a8c3b1}#digital-twin-loading-root li.complete .dtl-copy strong{color:#b1c4b5}#digital-twin-loading-root li.current .dtl-marker{border-color:rgba(201,174,130,.6);box-shadow:0 0 13px rgba(201,174,130,.14)}#digital-twin-loading-root li.current .dtl-marker i{background:#d1b17d;box-shadow:0 0 7px rgba(209,177,125,.55)}#digital-twin-loading-root li.current .dtl-copy strong{color:#e1d1b1}
            #digital-twin-loading-root .dtl-footer{position:absolute;bottom:23px;left:50%;display:flex;align-items:center;gap:10px;transform:translateX(-50%);color:#7f8079;font-size:8px;letter-spacing:.06em;white-space:nowrap}#digital-twin-loading-root .dtl-footer i{width:2px;height:2px;border-radius:50%;background:#b99c71}
            @keyframes dtl-float{0%,100%{transform:translateY(2px)}50%{transform:translateY(-5px)}}@keyframes dtl-pulse{50%{opacity:.42;box-shadow:0 0 3px rgba(145,180,163,.18)}}@keyframes dtl-lamp-breathe{0%,100%{opacity:.62;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}}@keyframes dtl-fire-breathe{0%,100%{opacity:.75;transform:scale(.8)}45%{opacity:1;transform:scale(1.25)}}@keyframes dtl-smoke-rise{0%{opacity:0;transform:translate(-50%,3px) scale(.45)}22%{opacity:.7}100%{opacity:0;transform:translate(30%,-36px) scale(1.9)}}
            @media(max-width:640px){#digital-twin-loading-root{padding:14px}#digital-twin-loading-root .dtl-card{width:100%;padding:20px 18px 18px}#digital-twin-loading-root .dtl-art{height:clamp(160px,45vw,235px)}#digital-twin-loading-root .dtl-phases{gap:5px}#digital-twin-loading-root .dtl-phases li{gap:5px}#digital-twin-loading-root .dtl-marker{width:15px;height:15px;flex-basis:15px}#digital-twin-loading-root .dtl-copy strong{font-size:8px}#digital-twin-loading-root .dtl-copy small{font-size:6px}#digital-twin-loading-root .dtl-live{font-size:7px}#digital-twin-loading-root .dtl-footer{bottom:10px;font-size:7px}}
            @media(prefers-reduced-motion:reduce){#digital-twin-loading-root .dtl-model-stage,#digital-twin-loading-root .dtl-live i,#digital-twin-loading-root [data-loading-effect] i,#digital-twin-loading-root .dtl-smoke:before,#digital-twin-loading-root .dtl-smoke:after{animation:none}}
          `;

          const root = document.createElement('div');
          root.id = 'digital-twin-loading-root';
          root.setAttribute('role', 'status');
          root.setAttribute('aria-live', 'polite');
          root.innerHTML = `
            <div class="dtl-atmosphere" aria-hidden="true"></div>
            <main class="dtl-card">
              <header class="dtl-heading"><span class="dtl-mark" aria-hidden="true"><i></i><i></i><i></i></span><span class="dtl-kicker">HEAT TREATMENT <i>/</i> DIGITAL TWIN</span><span class="dtl-live"><i></i> SYSTEM STARTUP</span></header>
              <div class="dtl-art"><div class="dtl-glow"></div><div class="dtl-model" aria-label="拖动旋转厂房示意图，滚轮缩放，双击复位"><div class="dtl-model-stage"><img src="/loading/industrial-factory.png" alt="" draggable="false"/><span class="dtl-smoke" data-smoke-index="0" style="left:26%;top:47.6%"></span><span class="dtl-smoke" data-smoke-index="1" style="left:60.5%;top:37%"></span><button type="button" data-loading-effect="lamp" data-tone="cyan" style="left:5.6%;top:53.2%" aria-label="入口状态灯，点击切换" aria-pressed="true" title="入口状态灯 · 点击开关"><i></i></button><button type="button" data-loading-effect="lamp" data-tone="cyan" style="left:18.7%;top:65%" aria-label="输送线状态灯，点击切换" aria-pressed="true" title="输送线状态灯 · 点击开关"><i></i></button><button type="button" data-loading-effect="lamp" data-tone="cyan" style="left:44.6%;top:56.8%" aria-label="热处理设备状态灯，点击切换" aria-pressed="true" title="热处理设备状态灯 · 点击开关"><i></i></button><button type="button" data-loading-effect="lamp" data-tone="cyan" style="left:61.6%;top:53.9%" aria-label="中段设备状态灯，点击切换" aria-pressed="true" title="中段设备状态灯 · 点击开关"><i></i></button><button type="button" data-loading-effect="lamp" data-tone="amber" style="left:76.8%;top:48.9%" aria-label="炉体指示灯，点击切换" aria-pressed="true" title="炉体指示灯 · 点击开关"><i></i></button><button type="button" data-loading-effect="lamp" data-tone="amber" style="left:87.8%;top:42.2%" aria-label="末端设备状态灯，点击切换" aria-pressed="true" title="末端设备状态灯 · 点击开关"><i></i></button><button type="button" data-loading-effect="smoke" data-smoke-index="0" style="left:26%;top:47.6%" aria-label="前段排气烟囱，点击切换排烟" aria-pressed="true" title="前段排气烟囱 · 点击切换排烟"><i></i></button><button type="button" data-loading-effect="smoke" data-smoke-index="1" style="left:60.5%;top:37%" aria-label="主排气烟囱，点击切换排烟" aria-pressed="true" title="主排气烟囱 · 点击切换排烟"><i></i></button><button type="button" data-loading-effect="furnace" style="left:27.3%;top:71.3%" aria-label="入口加热炉，点击点火或熄火" aria-pressed="true" title="入口加热炉 · 点击点火或熄火"><i></i></button><button type="button" data-loading-effect="furnace" style="left:71.6%;top:49.4%" aria-label="主加热炉，点击点火或熄火" aria-pressed="true" title="主加热炉 · 点击点火或熄火"><i></i></button></div></div><span class="dtl-caption"><i></i> FACTORY SYSTEMS <b>INITIALIZING</b></span><span class="dtl-index">拖动旋转 · 滚轮缩放 · 点击设备互动</span></div>
              <div class="dtl-status"><div><h1>正在准备生产现场</h1><p class="dtl-step">正在读取现场配置</p></div><strong class="dtl-percent">8<small>%</small></strong></div>
              <div class="dtl-track"><i class="dtl-fill"></i><b class="dtl-knob"></b></div>
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
          const updateModel = () => {
            model.style.setProperty('--dtl-tilt-x', modelTiltX + 'deg');
            model.style.setProperty('--dtl-tilt-y', modelTiltY + 'deg');
            model.style.setProperty('--dtl-scale', modelScale);
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

          const phases = ['正在读取现场配置', '正在构建三维场景', '正在装配设备模型', '正在连接实时数据'];
          const setProgress = (value, phase, step) => {
            const progress = Math.max(0, Math.min(100, Number(value) || 0));
            const current = Math.max(0, Math.min(3, Number.isFinite(Number(phase)) ? Number(phase) : Math.min(3, Math.floor(progress / 25))));
            root.querySelector('.dtl-fill').style.width = progress + '%';
            root.querySelector('.dtl-knob').style.left = progress + '%';
            root.querySelector('.dtl-percent').innerHTML = Math.round(progress) + '<small>%</small>';
            root.querySelector('.dtl-step').textContent = step || phases[current];
            root.querySelectorAll('.dtl-phases li').forEach((item, index) => item.classList.toggle('complete', index < current));
            root.querySelectorAll('.dtl-phases li').forEach((item, index) => item.classList.toggle('current', index === current));
          };
          window.__DIGITAL_TWIN_LOADING_PROGRESS__ = detail => setProgress(detail?.progress, detail?.phase, detail?.step);
          let progressTimer = 0;
          window.__DIGITAL_TWIN_FINISH_LOADING__ = () => {
            window.clearInterval(progressTimer);
            setProgress(100, 3, '生产现场已就绪');
            root.classList.add('is-leaving');
            window.setTimeout(() => { root.remove(); style.remove(); window.__DIGITAL_TWIN_LOADING_ROOT__ = null; }, 450);
          };
          const began = performance.now();
          progressTimer = window.setInterval(() => {
            if (!root.isConnected) { window.clearInterval(progressTimer); return; }
            const progress = Math.min(90, 8 + (performance.now() - began) / 95);
            setProgress(progress, Math.min(3, Math.floor(progress / 25)));
          }, 140);
          window.addEventListener('digital-twin-loading-progress', event => window.__DIGITAL_TWIN_LOADING_PROGRESS__(event.detail));
        })();
        """;
}
