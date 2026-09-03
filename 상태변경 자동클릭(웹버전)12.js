(() => {
  "use strict";

  if (window.__iphoneReloadWatcherInstalled) {
    alert("감시 도구가 이미 실행 중입니다.");
    return;
  }

  window.__iphoneReloadWatcherInstalled = true;

  const STORE_KEY = "__iphone_reload_watcher_state_v4";
  const LONG_PRESS_TIME = 700;
  const DRAG_DISTANCE = 15;

  let state = {
    enabled: false,
    paused: false,
    mode: null,
    selector: null,
    region: null,
    signature: null,
    regionItems: {},
    startTime: "",
    endTime: "",
    leadSeconds: 0,
    reloadOnChange: true,
    lastScheduleKey: ""
  };

  try {
    const saved = sessionStorage.getItem(STORE_KEY);
    if (saved) {
      state = Object.assign(state, JSON.parse(saved));
    }
  } catch (e) {
    console.warn("저장된 설정을 읽을 수 없습니다.", e);
  }

  function saveState() {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn("설정 저장 실패:", e);
    }
  }

  function isOwnElement(el) {
    return (
      el &&
      (
        el.id === "__iphone_reload_watcher_panel" ||
        el.id === "__iphone_reload_watcher_region" ||
        el.id === "__iphone_reload_watcher_controls" ||
        el.closest?.(
          "#__iphone_reload_watcher_panel," +
          "#__iphone_reload_watcher_controls"
        )
      )
    );
  }

  function getText(el) {
    if (!el) return "";

    return (
      el.innerText ||
      el.textContent ||
      el.value ||
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
  }

  function getCode(el) {
    if (!el) return "";

    const attrs = [
      "data-code",
      "data-id",
      "data-item-code",
      "data-product-code",
      "data-stock-code",
      "name",
      "id"
    ];

    for (const attr of attrs) {
      const value = el.getAttribute(attr);
      if (value) {
        return `${attr}=${value}`;
      }
    }

    return (
      el.tagName.toLowerCase() +
      (
        el.className
          ? "." + String(el.className).trim().replace(/\s+/g, ".")
          : ""
      )
    );
  }

  function makeSelector(el) {
    if (!el || el.nodeType !== 1) return null;

    if (el.id) {
      return `#${CSS.escape(el.id)}`;
    }

    const codeAttrs = [
      "data-code",
      "data-id",
      "data-item-code",
      "data-product-code",
      "data-stock-code"
    ];

    for (const attr of codeAttrs) {
      const value = el.getAttribute(attr);

      if (value) {
        const selector =
          `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(value)}"]`;

        try {
          if (document.querySelectorAll(selector).length === 1) {
            return selector;
          }
        } catch (e) {}
      }
    }

    const path = [];
    let current = el;

    while (
      current &&
      current.nodeType === 1 &&
      current !== document.body &&
      path.length < 8
    ) {
      let part = current.tagName.toLowerCase();

      if (current.classList && current.classList.length) {
        const classes = [...current.classList]
          .filter(c => !c.includes("active"))
          .filter(c => !c.includes("selected"))
          .filter(c => !c.includes("hover"))
          .slice(0, 2);

        if (classes.length) {
          part += "." + classes.map(c => CSS.escape(c)).join(".");
        }
      }

      const parent = current.parentElement;

      if (parent) {
        const sameTag = [...parent.children]
          .filter(x => x.tagName === current.tagName);

        if (sameTag.length > 1) {
          part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
        }
      }

      path.unshift(part);
      current = current.parentElement;
    }

    const selector = path.join(" > ");

    try {
      if (document.querySelectorAll(selector).length === 1) {
        return selector;
      }
    } catch (e) {}

    return null;
  }

  function getVisualInfo(el) {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    return {
      color: style.color,
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      opacity: style.opacity,
      visibility: style.visibility,
      display: style.display,
      fontWeight: style.fontWeight,
      textDecoration: style.textDecoration,
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function makeSignature(el) {
    if (!el) return null;

    const attrs = [...el.attributes]
      .map(a => `${a.name}=${a.value}`)
      .sort()
      .join("|");

    return JSON.stringify({
      text: getText(el),
      value: el.value ?? "",
      html: el.innerHTML.slice(0, 1000),
      className: String(el.className || ""),
      style: el.getAttribute("style") || "",
      disabled: !!el.disabled,
      hidden: !!el.hidden,
      attributes: attrs,
      visual: getVisualInfo(el)
    });
  }

  function isVisible(el) {
    if (!el || isOwnElement(el)) return false;

    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);

    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  }

  function isClickable(el) {
    if (!el || !isVisible(el)) return false;

    const tag = el.tagName.toLowerCase();

    return (
      ["button", "a", "input", "select", "textarea", "option"]
        .includes(tag) ||
      el.getAttribute("role") === "button" ||
      el.hasAttribute("onclick") ||
      el.hasAttribute("tabindex")
    );
  }

  function findClickable(el) {
    if (!el) return null;
    if (isClickable(el)) return el;

    const parent = el.closest?.(
      "button,a,input,select,textarea,option," +
      "[role='button'],[onclick],[tabindex]"
    );

    return isClickable(parent) ? parent : null;
  }

  function createPanel() {
    let panel = document.getElementById(
      "__iphone_reload_watcher_panel"
    );

    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = "__iphone_reload_watcher_panel";

    Object.assign(panel.style, {
      position: "fixed",
      zIndex: "2147483647",
      left: "8px",
      right: "8px",
      bottom: "8px",
      background: "rgba(0,0,0,.88)",
      color: "white",
      padding: "10px",
      borderRadius: "10px",
      fontSize: "13px",
      lineHeight: "1.5",
      fontFamily: "Arial,sans-serif",
      boxSizing: "border-box",
      boxShadow: "0 2px 12px rgba(0,0,0,.4)"
    });

    panel.innerHTML = `
      <div id="__watcher_status" style="margin-bottom:8px">
        감시할 지점을 꾹 누르세요.<br>
        꾹 누른 상태로 이동하면 드래그 범위를 감시합니다.
      </div>

      <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap">
        <label>시작
          <input id="__watcher_start" type="time" step="1"
            style="font-size:13px;width:105px">
        </label>

        <label>종료
          <input id="__watcher_end" type="time" step="1"
            style="font-size:13px;width:105px">
        </label>

        <label>
          <input id="__watcher_lead" type="number"
            min="0" step="0.1" inputmode="decimal"
            placeholder="0.0"
            style="width:58px;font-size:13px">
          초 전
        </label>

        <button id="__watcher_reload_now"
          style="font-size:12px;padding:5px 7px">
          새로고침
        </button>
      </div>
    `;

    document.documentElement.appendChild(panel);

    panel.querySelector("#__watcher_start").value =
      state.startTime || "";

    panel.querySelector("#__watcher_end").value =
      state.endTime || "";

    panel.querySelector("#__watcher_lead").value =
      Number.isFinite(Number(state.leadSeconds))
        ? state.leadSeconds
        : 0;

    function updateTimeSettings() {
      state.startTime =
        panel.querySelector("#__watcher_start").value;

      state.endTime =
        panel.querySelector("#__watcher_end").value;

      state.leadSeconds = Math.max(
        0,
        Number(
          panel.querySelector("#__watcher_lead").value || 0
        )
      );

      saveState();
      showStatus("시간 설정이 저장되었습니다.");
    }

    panel.querySelector("#__watcher_start")
      .addEventListener("change", updateTimeSettings);

    panel.querySelector("#__watcher_end")
      .addEventListener("change", updateTimeSettings);

    panel.querySelector("#__watcher_lead")
      .addEventListener("change", updateTimeSettings);

    panel.querySelector("#__watcher_reload_now")
      .addEventListener("click", () => {
        showStatus("수동 새로고침합니다.");

        setTimeout(() => {
          location.reload();
        }, 100);
      });

    return panel;
  }

  function createControls() {
    let controls = document.getElementById(
      "__iphone_reload_watcher_controls"
    );

    if (controls) return controls;

    controls = document.createElement("div");
    controls.id = "__iphone_reload_watcher_controls";

    Object.assign(controls.style, {
      position: "fixed",
      zIndex: "2147483647",
      right: "8px",
      top: "45%",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      padding: "6px",
      background: "rgba(0,0,0,.78)",
      borderRadius: "10px",
      boxShadow: "0 2px 10px rgba(0,0,0,.35)"
    });

    controls.innerHTML = `
      <button id="__watcher_play"
        title="재생"
        style="width:42px;height:38px;font-size:20px">
        ▶
      </button>

      <button id="__watcher_pause"
        title="일시정지"
        style="width:42px;height:38px;font-size:18px">
        Ⅱ
      </button>

      <button id="__watcher_stop"
        title="정지 및 재설정"
        style="width:42px;height:38px;font-size:20px;color:red">
        ■
      </button>
    `;

    document.documentElement.appendChild(controls);

    controls.querySelector("#__watcher_play")
      .addEventListener("click", event => {
        event.stopPropagation();

        if (!state.enabled) {
          showStatus("먼저 포인트나 드래그 범위를 지정하세요.");
          return;
        }

        state.paused = false;
        saveState();

        showStatus(
          "감시를 재생했습니다.<br>현재 설정을 유지합니다."
        );
      });

    controls.querySelector("#__watcher_pause")
      .addEventListener("click", event => {
        event.stopPropagation();

        if (!state.enabled) {
          showStatus("현재 감시 중인 포인트나 범위가 없습니다.");
          return;
        }

        state.paused = true;
        saveState();

        showStatus(
          "감시를 일시정지했습니다.<br>설정된 포인트·범위는 유지됩니다."
        );
      });

    controls.querySelector("#__watcher_stop")
      .addEventListener("click", event => {
        event.stopPropagation();
        stopAndReset();
      });

    return controls;
  }

  function showStatus(message) {
    const panel = createPanel();
    const status = panel.querySelector("#__watcher_status");

    if (status) {
      status.innerHTML = message;
    }
  }

  function createRegionBox() {
    let box = document.getElementById(
      "__iphone_reload_watcher_region"
    );

    if (box) return box;

    box = document.createElement("div");
    box.id = "__iphone_reload_watcher_region";

    Object.assign(box.style, {
      position: "fixed",
      zIndex: "2147483646",
      border: "2px solid #00ff66",
      background: "rgba(0,255,100,.08)",
      pointerEvents: "none",
      display: "none",
      boxSizing: "border-box"
    });

    document.documentElement.appendChild(box);
    return box;
  }

  function drawRegion(region) {
    const box = createRegionBox();

    Object.assign(box.style, {
      display: "block",
      left: `${region.left}px`,
      top: `${region.top}px`,
      width: `${region.width}px`,
      height: `${region.height}px`
    });
  }

  function hideRegion() {
    const box = document.getElementById(
      "__iphone_reload_watcher_region"
    );

    if (box) {
      box.style.display = "none";
    }
  }

  function clearOutline() {
    document
      .querySelectorAll("[data-iphone-reload-outline]")
      .forEach(el => {
        el.style.outline =
          el.dataset.oldIphoneOutline || "";

        delete el.dataset.oldIphoneOutline;
        delete el.dataset.iphoneReloadOutline;
      });
  }

  function outline(el, color = "#00ff66") {
    if (!el || isOwnElement(el)) return;

    if (!el.dataset.iphoneReloadOutline) {
      el.dataset.oldIphoneOutline =
        el.style.outline || "";

      el.dataset.iphoneReloadOutline = "1";
    }

    el.style.outline = `3px solid ${color}`;
  }

  function normalizeRegion(a, b) {
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const right = Math.max(a.x, b.x);
    const bottom = Math.max(a.y, b.y);

    return {
      left,
      top,
      width: right - left,
      height: bottom - top
    };
  }

  function intersects(rect, region) {
    return !(
      rect.right < region.left ||
      rect.left > region.left + region.width ||
      rect.bottom < region.top ||
      rect.top > region.top + region.height
    );
  }

  function collectRegionItems(region) {
    const result = {};
    const elements = [
      ...document.body.querySelectorAll("*")
    ];

    for (const el of elements) {
      if (isOwnElement(el) || !isVisible(el)) continue;

      const rect = el.getBoundingClientRect();

      if (!intersects(rect, region)) continue;

      const clickable = findClickable(el);
      const target = clickable || el;
      const selector = makeSelector(target);

      if (!selector) continue;

      if (!result[selector]) {
        result[selector] = {
          selector,
          signature: makeSignature(target),
          clickable: !!clickable,
          text: getText(target),
          code: getCode(target)
        };
      }
    }

    return result;
  }

  function getElement(selector) {
    if (!selector) return null;

    try {
      return document.querySelector(selector);
    } catch (e) {
      return null;
    }
  }

  function stopAndReset() {
    state.enabled = false;
    state.paused = false;
    state.mode = null;
    state.selector = null;
    state.region = null;
    state.signature = null;
    state.regionItems = {};

    clearOutline();
    hideRegion();
    saveState();

    showStatus(
      "정지했습니다.<br>" +
      "설정이 삭제되었습니다.<br>" +
      "새 포인트를 꾹 누르거나 드래그하세요."
    );
  }

  function reloadBecauseOfChange(message) {
    if (!state.enabled || state.paused) return;

    showStatus(
      `${message}<br>` +
      `<b style="color:#ffeb3b">변화 감지 — 새로고침합니다.</b>`
    );

    saveState();

    setTimeout(() => {
      location.reload();
    }, 100);
  }

  function monitorSingle() {
    const el = getElement(state.selector);

    if (!el) {
      reloadBecauseOfChange("감시 대상이 사라졌습니다.");
      return;
    }

    const current = makeSignature(el);

    if (state.signature && current !== state.signature) {
      outline(el, "#ff3333");

      reloadBecauseOfChange(
        `단일 지점 변화 감지<br>` +
        `코드: ${getCode(el)}<br>` +
        `내용: ${getText(el)}`
      );

      state.signature = current;
      saveState();
    }
  }

  function monitorRegion() {
    if (!state.region) return;

    const currentItems =
      collectRegionItems(state.region);

    const oldItems = state.regionItems || {};
    let changedItem = null;

    for (const key of Object.keys(currentItems)) {
      if (
        !oldItems[key] ||
        oldItems[key].signature !==
        currentItems[key].signature
      ) {
        changedItem = currentItems[key];
        break;
      }
    }

    if (!changedItem) {
      for (const key of Object.keys(oldItems)) {
        if (!currentItems[key]) {
          changedItem = oldItems[key];
          break;
        }
      }
    }

    if (changedItem) {
      const el = getElement(changedItem.selector);

      if (el) {
        outline(el, "#ff3333");

        el.scrollIntoView({
          behavior: "smooth",
          block: "center",
          inline: "center"
        });
      }

      reloadBecauseOfChange(
        `드래그 범위 안 변화 감지<br>` +
        `코드: ${changedItem.code || "확인 불가"}<br>` +
        `내용: ${changedItem.text || "내용 없음"}`
      );
    }

    state.regionItems = currentItems;
    saveState();
  }

  function parseTime(value) {
    if (!value) return null;

    const parts = value.split(":").map(Number);

    if (parts.length < 2) return null;

    return (
      parts[0] * 3600 +
      parts[1] * 60 +
      (parts[2] || 0)
    );
  }

  function nowSeconds() {
    const now = new Date();

    return (
      now.getHours() * 3600 +
      now.getMinutes() * 60 +
      now.getSeconds() +
      now.getMilliseconds() / 1000
    );
  }

  function isFocusTime() {
    const start = parseTime(state.startTime);
    const end = parseTime(state.endTime);

    if (start === null || end === null) return false;
    if (start === end) return false;

    const now = nowSeconds();

    if (start < end) {
      return now >= start && now <= end;
    }

    return now >= start || now <= end;
  }

  function checkScheduledReload() {
    const start = parseTime(state.startTime);
    const end = parseTime(state.endTime);

    if (start === null || end === null) return;
    if (start !== end) return;

    const now = new Date();
    const target = new Date(now);

    target.setHours(
      Math.floor(start / 3600),
      Math.floor((start % 3600) / 60),
      start % 60,
      0
    );

    let reloadAt =
      target.getTime() -
      Number(state.leadSeconds || 0) * 1000;

    if (Date.now() > reloadAt + 1500) {
      target.setDate(target.getDate() + 1);

      target.setHours(
        Math.floor(start / 3600),
        Math.floor((start % 3600) / 60),
        start % 60,
        0
      );

      reloadAt =
        target.getTime() -
        Number(state.leadSeconds || 0) * 1000;
    }

    const dateKey = target.toISOString().slice(0, 10);

    const scheduleKey =
      `${dateKey}_${state.startTime}_${state.leadSeconds}`;

    if (
      Date.now() >= reloadAt &&
      Date.now() <= reloadAt + 1500 &&
      state.lastScheduleKey !== scheduleKey
    ) {
      state.lastScheduleKey = scheduleKey;
      saveState();

      showStatus(
        `${state.leadSeconds}초 전 예약 새로고침을 실행합니다.`
      );

      setTimeout(() => {
        location.reload();
      }, 100);
    }
  }

  function selectSingle(el) {
    if (!el || isOwnElement(el)) return;

    const clickable = findClickable(el);
    const target = clickable || el;
    const selector = makeSelector(target);

    if (!selector) {
      showStatus("이 지점은 식별할 수 없습니다.");
      return;
    }

    if (
      state.enabled &&
      state.mode === "single" &&
      state.selector === selector
    ) {
      state.paused = true;
      showStatus(
        "현재 포인트를 일시정지했습니다.<br>" +
        "다시 꾹 누르면 감시를 재개합니다."
      );
      saveState();
      return;
    }

    state.enabled = true;
    state.paused = false;
    state.mode = "single";
    state.selector = selector;
    state.region = null;
    state.signature = makeSignature(target);
    state.regionItems = {};

    clearOutline();
    hideRegion();
    outline(target, "#00ff66");
    saveState();

    showStatus(
      `단일 포인트 감시 중<br>` +
      `코드: ${getCode(target)}<br>` +
      `내용: ${getText(target) || "내용 없음"}`
    );
  }

  function selectRegion(region) {
    if (region.width < 10 || region.height < 10) {
      const el = document.elementFromPoint(
        region.left + region.width / 2,
        region.top + region.height / 2
      );

      selectSingle(el);
      return;
    }

    state.enabled = true;
    state.paused = false;
    state.mode = "region";
    state.selector = null;
    state.region = region;
    state.signature = null;
    state.regionItems = collectRegionItems(region);

    clearOutline();
    drawRegion(region);
    saveState();

    showStatus(
      `드래그 범위 감시 중<br>` +
      `항목 ${Object.keys(state.regionItems).length}개 확인<br>` +
      `변화가 감지되면 새로고침합니다.`
    );
  }

  let startPoint = null;
  let lastPoint = null;
  let pressTimer = null;
  let moved = false;

  function pointFromTouch(touch) {
    return {
      x: touch.clientX,
      y: touch.clientY
    };
  }

  document.addEventListener(
    "touchstart",
    event => {
      if (event.touches.length !== 1) return;

      const touch = event.touches[0];
      const el = document.elementFromPoint(
        touch.clientX,
        touch.clientY
      );

      if (isOwnElement(el)) return;

      startPoint = pointFromTouch(touch);
      lastPoint = startPoint;
      moved = false;

      clearTimeout(pressTimer);

      pressTimer = setTimeout(() => {
        if (!moved && startPoint) {
          const target = document.elementFromPoint(
            startPoint.x,
            startPoint.y
          );

          if (target && !isOwnElement(target)) {
            selectSingle(target);
          }
        }
      }, LONG_PRESS_TIME);
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    "touchmove",
    event => {
      if (!startPoint || event.touches.length !== 1) return;

      const current = pointFromTouch(event.touches[0]);
      lastPoint = current;

      const distance = Math.hypot(
        current.x - startPoint.x,
        current.y - startPoint.y
      );

      if (distance > DRAG_DISTANCE) {
        moved = true;
        clearTimeout(pressTimer);

        drawRegion(
          normalizeRegion(startPoint, current)
        );
      }
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    "touchend",
    () => {
      clearTimeout(pressTimer);

      if (!startPoint) return;

      if (moved && lastPoint) {
        selectRegion(
          normalizeRegion(startPoint, lastPoint)
        );
      }

      startPoint = null;
      lastPoint = null;
      moved = false;
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    "touchcancel",
    () => {
      clearTimeout(pressTimer);
      startPoint = null;
      lastPoint = null;
      moved = false;
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    "contextmenu",
    event => {
      if (!isOwnElement(event.target)) {
        event.preventDefault();
      }
    },
    { capture: true }
  );

  createPanel();
  createControls();

  if (state.mode === "region" && state.region) {
    drawRegion(state.region);
  }

  if (state.enabled && !state.paused) {
    if (state.mode === "single") {
      const restored = getElement(state.selector);

      if (restored) {
        outline(restored, "#00ff66");

        showStatus(
          "이전 포인트 감시를 재개했습니다.<br>" +
          "변화 시 새로고침합니다."
        );
      }
    } else if (state.mode === "region") {
      showStatus(
        "이전 드래그 범위 감시를 재개했습니다.<br>" +
        "변화 시 새로고침합니다."
      );
    }
  } else if (state.paused) {
    showStatus(
      "감시가 일시정지된 상태입니다.<br>" +
      "오른쪽 ▶ 버튼을 누르면 재개됩니다."
    );
  }

  let lastCheck = 0;

  setInterval(() => {
    const now = Date.now();
    const focus = isFocusTime();
    const interval = focus ? 100 : 1000;

    if (now - lastCheck < interval) return;
    lastCheck = now;

    if (!state.enabled || state.paused) return;

    checkScheduledReload();

    if (state.mode === "single") {
      monitorSingle();
    } else if (state.mode === "region") {
      monitorRegion();
    }
  }, 50);

  if (!state.enabled) {
    showStatus(
      "감시할 지점을 꾹 누르세요.<br>" +
      "꾹 누른 상태로 이동하면 드래그 범위가 설정됩니다."
    );
  }
})();
