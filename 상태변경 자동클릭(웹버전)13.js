// ==UserScript==
// @name         iPhone 변경 감지 · 예약 새로고침 · 더블 터치
// @namespace    iphone-reload-double-touch
// @version      5.0.0
// @description  포인트/범위 변경 감지 또는 예약 시간에 새로고침 후 더블 터치
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(async () => {
  "use strict";

  // =========================================================
  // 기본 설정
  // =========================================================

  const START_URL = "https://www.naver.com/";

  const STORE_KEY = "__iphone_reload_watcher_state_v5";
  const FIRST_START_KEY = "__iphone_reload_watcher_started_v5";

  const PANEL_ID = "__iphone_reload_watcher_panel";
  const CONTROLS_ID = "__iphone_reload_watcher_controls";
  const REGION_ID = "__iphone_reload_watcher_region";

  const LONG_PRESS_TIME = 700;
  const DRAG_DISTANCE = 15;

  const NORMAL_CHECK_INTERVAL = 1000;
  const FAST_CHECK_INTERVAL = 100;

  const DOUBLE_TOUCH_INTERVAL = 130;
  const POST_RELOAD_DELAY = 700;

  /*
   * 일부 웹사이트는 로드 직후 내용이 계속 바뀌므로
   * 시작 후 잠시 기준 화면을 안정화합니다.
   */
  const INITIAL_STABILIZE_TIME = 1200;

  if (window.__iphoneReloadWatcherInstalled) {
    return;
  }

  window.__iphoneReloadWatcherInstalled = true;


  // =========================================================
  // 저장소
  // =========================================================

  function storageGet(key, defaultValue) {
    try {
      if (typeof GM_getValue === "function") {
        return GM_getValue(key, defaultValue);
      }
    } catch (error) {
      console.warn("GM_getValue 실패:", error);
    }

    try {
      const value = localStorage.getItem(key);

      if (value === null) {
        return defaultValue;
      }

      return JSON.parse(value);
    } catch (error) {
      return defaultValue;
    }
  }

  function storageSet(key, value) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(key, value);
        return;
      }
    } catch (error) {
      console.warn("GM_setValue 실패:", error);
    }

    try {
      localStorage.setItem(
        key,
        JSON.stringify(value)
      );
    } catch (error) {
      console.warn("localStorage 저장 실패:", error);
    }
  }


  // =========================================================
  // 최초 화면을 네이버로 이동
  // =========================================================

  const firstStarted = storageGet(
    FIRST_START_KEY,
    false
  );

  if (!firstStarted) {
    storageSet(FIRST_START_KEY, true);

    const currentUrl =
      location.href.replace(/\/+$/, "");

    const startUrl =
      START_URL.replace(/\/+$/, "");

    if (currentUrl !== startUrl) {
      location.replace(START_URL);
      return;
    }
  }


  // =========================================================
  // 상태
  // =========================================================

  const defaultState = {
    enabled: false,
    paused: false,

    mode: null,

    /*
     * single 모드
     */
    selector: null,
    point: null,
    signature: null,

    /*
     * region 모드
     */
    region: null,
    regionItems: {},

    /*
     * 예약 시간
     */
    scheduleTime: "",
    leadSeconds: 0,
    lastScheduleKey: "",

    /*
     * 예약 새로고침 후 자동 터치 여부
     */
    pendingTouchAfterReload: false,
    pendingTouchReason: "",

    selectedAt: 0
  };

  let state = Object.assign(
    {},
    defaultState,
    storageGet(STORE_KEY, {})
  );

  let actionInProgress = false;
  let lastCheckTime = 0;
  let initializedAt = Date.now();

  function saveState() {
    storageSet(STORE_KEY, state);
  }

  function replaceState(nextState) {
    state = Object.assign(
      {},
      defaultState,
      nextState || {}
    );

    saveState();
  }


  // =========================================================
  // 공통 함수
  // =========================================================

  function get(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function isOwnElement(element) {
    if (!element) {
      return false;
    }

    if (
      element.id === PANEL_ID ||
      element.id === CONTROLS_ID ||
      element.id === REGION_ID
    ) {
      return true;
    }

    if (element.closest) {
      return !!element.closest(
        `#${PANEL_ID},#${CONTROLS_ID}`
      );
    }

    return false;
  }

  function getText(element) {
    if (!element) {
      return "";
    }

    return (
      element.innerText ||
      element.textContent ||
      element.value ||
      element.getAttribute?.("aria-label") ||
      element.getAttribute?.("title") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
  }

  function getCode(element) {
    if (!element) {
      return "";
    }

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
      const value = element.getAttribute?.(attr);

      if (value) {
        return `${attr}=${value}`;
      }
    }

    const tagName =
      element.tagName?.toLowerCase() || "element";

    let classPart = "";

    if (element.className) {
      classPart =
        "." +
        String(element.className)
          .trim()
          .replace(/\s+/g, ".");
    }

    return tagName + classPart;
  }

  function getElement(selector) {
    if (!selector) {
      return null;
    }

    try {
      return document.querySelector(selector);
    } catch (error) {
      return null;
    }
  }


  // =========================================================
  // 요소 식별
  // =========================================================

  function makeSelector(element) {
    if (
      !element ||
      element.nodeType !== Node.ELEMENT_NODE
    ) {
      return null;
    }

    if (element.id) {
      try {
        const selector =
          "#" + CSS.escape(element.id);

        if (
          document.querySelectorAll(selector).length === 1
        ) {
          return selector;
        }
      } catch (error) {
        // 다음 방식으로 계속 진행
      }
    }

    const codeAttrs = [
      "data-code",
      "data-id",
      "data-item-code",
      "data-product-code",
      "data-stock-code",
      "name"
    ];

    for (const attr of codeAttrs) {
      const value = element.getAttribute(attr);

      if (!value) {
        continue;
      }

      try {
        const selector =
          element.tagName.toLowerCase() +
          `[${attr}="${CSS.escape(value)}"]`;

        if (
          document.querySelectorAll(selector).length === 1
        ) {
          return selector;
        }
      } catch (error) {
        // 다음 속성 확인
      }
    }

    const path = [];
    let current = element;

    while (
      current &&
      current.nodeType === Node.ELEMENT_NODE &&
      current !== document.body &&
      current !== document.documentElement &&
      path.length < 10
    ) {
      let part = current.tagName.toLowerCase();

      if (
        current.classList &&
        current.classList.length
      ) {
        const classes = [...current.classList]
          .filter(name => {
            return (
              !name.includes("active") &&
              !name.includes("selected") &&
              !name.includes("hover") &&
              !name.includes("focus") &&
              !name.startsWith("__iphone")
            );
          })
          .slice(0, 2);

        if (classes.length) {
          try {
            part +=
              "." +
              classes
                .map(name => CSS.escape(name))
                .join(".");
          } catch (error) {
            // 클래스는 생략
          }
        }
      }

      const parent = current.parentElement;

      if (parent) {
        const sameTag = [...parent.children]
          .filter(child => {
            return (
              child.tagName === current.tagName
            );
          });

        if (sameTag.length > 1) {
          const index =
            sameTag.indexOf(current);

          part +=
            `:nth-of-type(${index + 1})`;
        }
      }

      path.unshift(part);
      current = current.parentElement;
    }

    const selector = path.join(" > ");

    if (!selector) {
      return null;
    }

    try {
      if (
        document.querySelectorAll(selector).length === 1
      ) {
        return selector;
      }
    } catch (error) {
      return null;
    }

    return null;
  }


  // =========================================================
  // 화면 상태 및 클릭 가능 요소
  // =========================================================

  function isVisible(element) {
    if (!element || isOwnElement(element)) {
      return false;
    }

    const rect =
      element.getBoundingClientRect();

    const style =
      getComputedStyle(element);

    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || 1) !== 0
    );
  }

  function isClickable(element) {
    if (!element || !isVisible(element)) {
      return false;
    }

    const tag =
      element.tagName.toLowerCase();

    return (
      [
        "button",
        "a",
        "input",
        "select",
        "textarea",
        "option",
        "label",
        "summary"
      ].includes(tag) ||
      element.getAttribute("role") === "button" ||
      element.getAttribute("role") === "link" ||
      element.hasAttribute("onclick") ||
      element.hasAttribute("tabindex")
    );
  }

  function findClickable(element) {
    if (!element) {
      return null;
    }

    if (isClickable(element)) {
      return element;
    }

    const parent = element.closest?.(
      "button,a,input,select,textarea,option," +
      "label,summary,[role='button'],[role='link']," +
      "[onclick],[tabindex]"
    );

    if (parent && isClickable(parent)) {
      return parent;
    }

    return null;
  }

  function getVisualInfo(element) {
    const style =
      getComputedStyle(element);

    const rect =
      element.getBoundingClientRect();

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

  function makeSignature(element) {
    if (!element) {
      return null;
    }

    /*
     * 감시 도구가 추가한 outline/style 때문에
     * 자기 자신을 변화로 오인하지 않도록 style과
     * watcher 관련 속성은 제외합니다.
     */
    const attrs = [...element.attributes]
      .filter(attr => {
        return (
          attr.name !== "style" &&
          !attr.name.startsWith("data-iphone-reload")
        );
      })
      .map(attr => {
        return `${attr.name}=${attr.value}`;
      })
      .sort()
      .join("|");

    let html = "";

    try {
      html = element.innerHTML
        .replace(
          /data-iphone-reload-[^=]*="[^"]*"/g,
          ""
        )
        .slice(0, 1500);
    } catch (error) {
      html = "";
    }

    return JSON.stringify({
      text: getText(element),
      value: element.value ?? "",
      html,
      className: String(
        element.className || ""
      ),
      disabled: !!element.disabled,
      hidden: !!element.hidden,
      attributes: attrs,
      visual: getVisualInfo(element)
    });
  }


  // =========================================================
  // 패널
  // =========================================================

  function createPanel() {
    let panel = get(PANEL_ID);

    if (panel) {
      return panel;
    }

    panel = document.createElement("div");
    panel.id = PANEL_ID;

    Object.assign(panel.style, {
      position: "fixed",
      zIndex: "2147483647",
      left: "8px",
      right: "8px",
      bottom: "8px",
      background: "rgba(0,0,0,.90)",
      color: "white",
      padding: "10px",
      borderRadius: "10px",
      fontSize: "13px",
      lineHeight: "1.5",
      fontFamily: "Arial,sans-serif",
      boxSizing: "border-box",
      boxShadow: "0 2px 12px rgba(0,0,0,.4)",
      WebkitUserSelect: "none",
      userSelect: "none"
    });

    panel.innerHTML = `
      <div
        id="__watcher_status"
        style="
          margin-bottom:8px;
          min-height:39px;
          word-break:keep-all;
        "
      >
        감시할 지점을 0.7초 이상 꾹 누르세요.
      </div>

      <div style="
        display:flex;
        gap:5px;
        align-items:center;
        flex-wrap:wrap;
      ">
        <label>
          시간
          <input
            id="__watcher_schedule"
            type="time"
            step="1"
            style="
              font-size:13px;
              width:110px;
              height:29px;
            "
          >
        </label>

        <label>
          <input
            id="__watcher_lead"
            type="number"
            min="0"
            step="0.1"
            inputmode="decimal"
            placeholder="0"
            style="
              width:58px;
              height:27px;
              font-size:13px;
            "
          >
          초 전
        </label>

        <button
          id="__watcher_clear_time"
          type="button"
          style="
            font-size:12px;
            padding:5px 7px;
          "
        >
          시간 해제
        </button>

        <button
          id="__watcher_reload_now"
          type="button"
          style="
            font-size:12px;
            padding:5px 7px;
          "
        >
          새로고침
        </button>
      </div>
    `;

    document.documentElement.appendChild(panel);

    const timeInput =
      panel.querySelector("#__watcher_schedule");

    const leadInput =
      panel.querySelector("#__watcher_lead");

    timeInput.value =
      state.scheduleTime || "";

    leadInput.value =
      Number.isFinite(Number(state.leadSeconds))
        ? String(state.leadSeconds)
        : "0";

    function updateTimeSettings(event) {
      event.stopPropagation();

      state.scheduleTime =
        timeInput.value || "";

      state.leadSeconds = Math.max(
        0,
        Number(leadInput.value || 0)
      );

      /*
       * 시간을 다시 변경하면 해당 예약을
       * 다시 실행할 수 있게 키를 비웁니다.
       */
      state.lastScheduleKey = "";

      saveState();

      if (state.scheduleTime) {
        showStatus(
          `예약 시간: ${escapeHtml(state.scheduleTime)}<br>` +
          `${escapeHtml(state.leadSeconds)}초 전에 새로고침 후 ` +
          `선택 부위를 두 번 터치합니다.`
        );
      } else {
        showStatus(
          "시간 설정이 해제되었습니다.<br>" +
          "변화 감지 방식으로 동작합니다."
        );
      }
    }

    timeInput.addEventListener(
      "change",
      updateTimeSettings
    );

    leadInput.addEventListener(
      "change",
      updateTimeSettings
    );

    panel
      .querySelector("#__watcher_clear_time")
      .addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();

        state.scheduleTime = "";
        state.leadSeconds = 0;
        state.lastScheduleKey = "";
        state.pendingTouchAfterReload = false;
        state.pendingTouchReason = "";

        timeInput.value = "";
        leadInput.value = "0";

        saveState();

        showStatus(
          "시간 설정을 해제했습니다.<br>" +
          "변화 감지 방식으로 동작합니다."
        );
      });

    panel
      .querySelector("#__watcher_reload_now")
      .addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();

        showStatus("수동 새로고침합니다.");

        setTimeout(() => {
          location.reload();
        }, 100);
      });

    /*
     * 패널에서 시작된 터치가 선택 이벤트로
     * 전달되는 것을 방지합니다.
     */
    [
      "touchstart",
      "touchmove",
      "touchend",
      "pointerdown",
      "pointerup",
      "click"
    ].forEach(type => {
      panel.addEventListener(
        type,
        event => {
          event.stopPropagation();
        },
        true
      );
    });

    return panel;
  }

  function showStatus(message) {
    const panel =
      get(PANEL_ID) || createPanel();

    const status =
      panel.querySelector("#__watcher_status");

    if (status) {
      status.innerHTML = message;
    }
  }


  // =========================================================
  // 재생 / 일시정지 / 정지
  // =========================================================

  function createControls() {
    let controls = get(CONTROLS_ID);

    if (controls) {
      return controls;
    }

    controls = document.createElement("div");
    controls.id = CONTROLS_ID;

    Object.assign(controls.style, {
      position: "fixed",
      zIndex: "2147483647",
      right: "8px",
      top: "42%",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      padding: "6px",
      background: "rgba(0,0,0,.80)",
      borderRadius: "10px",
      boxShadow: "0 2px 10px rgba(0,0,0,.35)",
      WebkitUserSelect: "none",
      userSelect: "none"
    });

    controls.innerHTML = `
      <button
        id="__watcher_play"
        type="button"
        title="재생"
        style="
          width:44px;
          height:40px;
          font-size:20px;
        "
      >
        ▶
      </button>

      <button
        id="__watcher_pause"
        type="button"
        title="일시정지"
        style="
          width:44px;
          height:40px;
          font-size:18px;
        "
      >
        Ⅱ
      </button>

      <button
        id="__watcher_stop"
        type="button"
        title="정지 및 재설정"
        style="
          width:44px;
          height:40px;
          font-size:20px;
          color:red;
        "
      >
        ■
      </button>
    `;

    document.documentElement.appendChild(controls);

    controls.addEventListener(
      "touchstart",
      event => {
        event.stopPropagation();
      },
      true
    );

    controls.addEventListener(
      "touchend",
      event => {
        event.stopPropagation();
      },
      true
    );

    controls
      .querySelector("#__watcher_play")
      .addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();

        if (!state.mode) {
          showStatus(
            "먼저 포인트 또는 범위를 지정해주세요."
          );
          return;
        }

        state.enabled = true;
        state.paused = false;

        /*
         * 재생 시 현재 화면을 새 기준으로 설정합니다.
         */
        refreshBaseline();
        saveState();

        if (state.scheduleTime) {
          showStatus(
            `예약 감시를 시작했습니다.<br>` +
            `${escapeHtml(state.scheduleTime)}의 ` +
            `${escapeHtml(state.leadSeconds)}초 전에 ` +
            `새로고침 후 두 번 터치합니다.`
          );
        } else {
          showStatus(
            "변화 감시를 시작했습니다.<br>" +
            "변화 시 해당 부위를 두 번 터치하고 정지합니다."
          );
        }
      });

    controls
      .querySelector("#__watcher_pause")
      .addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();

        if (!state.mode) {
          showStatus(
            "설정된 포인트나 범위가 없습니다."
          );
          return;
        }

        state.enabled = false;
        state.paused = true;

        saveState();

        showStatus(
          "일시정지했습니다.<br>" +
          "선택한 포인트·범위는 유지됩니다."
        );
      });

    controls
      .querySelector("#__watcher_stop")
      .addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();

        stopAndReset(
          "정지했습니다.<br>" +
          "다시 포인트를 꾹 누르거나 범위를 드래그하세요."
        );
      });

    return controls;
  }


  // =========================================================
  // 선택 표시
  // =========================================================

  function createRegionBox() {
    let box = get(REGION_ID);

    if (box) {
      return box;
    }

    box = document.createElement("div");
    box.id = REGION_ID;

    Object.assign(box.style, {
      position: "fixed",
      zIndex: "2147483646",
      border: "3px solid #00ff66",
      background: "rgba(0,255,100,.10)",
      pointerEvents: "none",
      display: "none",
      boxSizing: "border-box"
    });

    document.documentElement.appendChild(box);

    return box;
  }

  function drawRegion(region, color = "#00ff66") {
    if (!region) {
      return;
    }

    const box = createRegionBox();

    Object.assign(box.style, {
      display: "block",
      left: `${Math.round(region.left)}px`,
      top: `${Math.round(region.top)}px`,
      width: `${Math.max(
        1,
        Math.round(region.width)
      )}px`,
      height: `${Math.max(
        1,
        Math.round(region.height)
      )}px`,
      borderColor: color
    });
  }

  function hideRegion() {
    const box = get(REGION_ID);

    if (box) {
      box.style.display = "none";
    }
  }

  function clearOutline() {
    document
      .querySelectorAll(
        "[data-iphone-reload-outline]"
      )
      .forEach(element => {
        element.style.outline =
          element.dataset.oldIphoneOutline || "";

        delete element.dataset.oldIphoneOutline;
        delete element.dataset.iphoneReloadOutline;
      });
  }

  function outline(element, color = "#00ff66") {
    if (
      !element ||
      isOwnElement(element)
    ) {
      return;
    }

    if (!element.dataset.iphoneReloadOutline) {
      element.dataset.oldIphoneOutline =
        element.style.outline || "";

      element.dataset.iphoneReloadOutline = "1";
    }

    element.style.outline =
      `3px solid ${color}`;
  }

  function normalizeRegion(a, b) {
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const right = Math.max(a.x, b.x);
    const bottom = Math.max(a.y, b.y);

    return {
      left: Math.round(left),
      top: Math.round(top),
      width: Math.max(
        1,
        Math.round(right - left)
      ),
      height: Math.max(
        1,
        Math.round(bottom - top)
      )
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


  // =========================================================
  // 범위 내부 요소 수집
  // =========================================================

  function collectRegionItems(region) {
    const result = {};

    if (!region || !document.body) {
      return result;
    }

    const elements = [
      ...document.body.querySelectorAll("*")
    ];

    for (const element of elements) {
      if (
        isOwnElement(element) ||
        !isVisible(element)
      ) {
        continue;
      }

      const rect =
        element.getBoundingClientRect();

      if (!intersects(rect, region)) {
        continue;
      }

      const clickable =
        findClickable(element);

      const target =
        clickable || element;

      const selector =
        makeSelector(target);

      if (!selector || result[selector]) {
        continue;
      }

      result[selector] = {
        selector,
        signature: makeSignature(target),
        clickable: !!clickable,
        text: getText(target),
        code: getCode(target),

        centerX: Math.round(
          rect.left + rect.width / 2
        ),

        centerY: Math.round(
          rect.top + rect.height / 2
        )
      };
    }

    return result;
  }


  // =========================================================
  // 기준 상태 갱신
  // =========================================================

  function refreshBaseline() {
    if (state.mode === "single") {
      const element =
        getElement(state.selector);

      if (element) {
        state.signature =
          makeSignature(element);
      }
    } else if (
      state.mode === "region" &&
      state.region
    ) {
      state.regionItems =
        collectRegionItems(state.region);
    }

    saveState();
  }


  // =========================================================
  // 정지 및 초기화
  // =========================================================

  function stopAfterAction(message) {
    state.enabled = false;
    state.paused = false;
    state.pendingTouchAfterReload = false;
    state.pendingTouchReason = "";

    saveState();

    showStatus(
      `${message}<br>` +
      `<b style="color:#00ff66">자동 동작 후 정지했습니다.</b><br>` +
      `다시 실행하려면 ▶을 누르세요.<br>` +
      `다시 지정하려면 ■을 누르세요.`
    );
  }

  function stopAndReset(message) {
    state.enabled = false;
    state.paused = false;

    state.mode = null;
    state.selector = null;
    state.point = null;
    state.signature = null;

    state.region = null;
    state.regionItems = {};

    state.pendingTouchAfterReload = false;
    state.pendingTouchReason = "";
    state.selectedAt = 0;

    clearOutline();
    hideRegion();
    saveState();

    showStatus(
      message ||
      "정지했습니다.<br>다시 선택해주세요."
    );
  }


  // =========================================================
  // 합성 터치 및 클릭
  // =========================================================

  function dispatchPointerSequence(
    element,
    x,
    y
  ) {
    if (!element) {
      return false;
    }

    try {
      if (typeof PointerEvent === "function") {
        element.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 1,
            pointerType: "touch",
            isPrimary: true,
            clientX: x,
            clientY: y,
            button: 0,
            buttons: 1
          })
        );

        element.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 1,
            pointerType: "touch",
            isPrimary: true,
            clientX: x,
            clientY: y,
            button: 0,
            buttons: 0
          })
        );
      }

      element.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: 1
        })
      );

      element.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: 0
        })
      );

      element.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: x,
          clientY: y,
          button: 0
        })
      );

      /*
       * 일반적인 링크·버튼 동작을 위해 click()도 실행합니다.
       * 사이트에 따라 위 click 이벤트와 중복될 수 있으므로
       * 기본 이벤트가 취소되지 않은 경우에만 별도로 실행하는
       * 방식 대신 한 번의 click()을 최종 동작으로 사용합니다.
       */
      if (typeof element.click === "function") {
        element.click();
      }

      return true;
    } catch (error) {
      console.warn("합성 터치 실패:", error);
      return false;
    }
  }

  function getElementCenter(element) {
    if (!element) {
      return null;
    }

    const rect =
      element.getBoundingClientRect();

    if (
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      return null;
    }

    return {
      x: Math.round(
        rect.left + rect.width / 2
      ),
      y: Math.round(
        rect.top + rect.height / 2
      )
    };
  }

  function getTargetAtPoint(x, y) {
    let element =
      document.elementFromPoint(x, y);

    if (!element || isOwnElement(element)) {
      return null;
    }

    return findClickable(element) || element;
  }

  async function doubleTouchElement(
    element,
    fallbackPoint = null
  ) {
    if (!element || isOwnElement(element)) {
      return false;
    }

    try {
      element.scrollIntoView({
        behavior: "auto",
        block: "center",
        inline: "center"
      });
    } catch (error) {
      // 스크롤 실패는 무시
    }

    await sleep(100);

    let center =
      getElementCenter(element);

    if (!center && fallbackPoint) {
      center = fallbackPoint;
    }

    if (!center) {
      return false;
    }

    /*
     * 첫 번째 터치 전에 자동 정지 상태를 저장합니다.
     * 첫 번째 터치로 페이지가 이동해도 재실행되지 않습니다.
     */
    state.enabled = false;
    state.paused = false;
    state.pendingTouchAfterReload = false;
    state.pendingTouchReason = "";

    saveState();

    const firstResult =
      dispatchPointerSequence(
        element,
        center.x,
        center.y
      );

    await sleep(DOUBLE_TOUCH_INTERVAL);

    /*
     * 첫 번째 동작으로 DOM이 바뀌었을 수 있으므로
     * 같은 좌표에서 대상을 다시 찾습니다.
     */
    const secondElement =
      getTargetAtPoint(center.x, center.y) ||
      element;

    const secondResult =
      dispatchPointerSequence(
        secondElement,
        center.x,
        center.y
      );

    return firstResult || secondResult;
  }

  async function doubleTouchSelectedArea(
    preferredElement = null
  ) {
    if (actionInProgress) {
      return false;
    }

    actionInProgress = true;

    try {
      let target = preferredElement;
      let point = null;

      if (
        !target &&
        state.mode === "single"
      ) {
        target =
          getElement(state.selector);

        if (!target && state.point) {
          point = {
            x: state.point.x,
            y: state.point.y
          };

          target = getTargetAtPoint(
            point.x,
            point.y
          );
        }
      }

      if (
        !target &&
        state.mode === "region" &&
        state.region
      ) {
        point = {
          x: Math.round(
            state.region.left +
            state.region.width / 2
          ),
          y: Math.round(
            state.region.top +
            state.region.height / 2
          )
        };

        target = getTargetAtPoint(
          point.x,
          point.y
        );

        /*
         * 범위 중앙에 클릭 가능한 요소가 없다면
         * 범위 내부의 첫 클릭 가능 요소를 찾습니다.
         */
        if (!findClickable(target)) {
          const items =
            collectRegionItems(state.region);

          const clickableItem =
            Object.values(items)
              .find(item => item.clickable);

          if (clickableItem) {
            const found =
              getElement(clickableItem.selector);

            if (found) {
              target =
                findClickable(found) || found;
            }
          }
        }
      }

      if (!target) {
        stopAndReset(
          "자동 터치 대상을 찾지 못했습니다.<br>" +
          "선택 설정을 초기화했습니다.<br>" +
          "다시 포인트나 범위를 지정해주세요."
        );

        return false;
      }

      target =
        findClickable(target) || target;

      outline(target, "#ff3333");

      const success =
        await doubleTouchElement(
          target,
          point
        );

      if (success) {
        stopAfterAction(
          "선택 부위를 두 번 터치했습니다."
        );

        return true;
      }

      stopAndReset(
        "자동 터치를 실행하지 못했습니다.<br>" +
        "설정을 초기화했습니다.<br>" +
        "다시 선택해주세요."
      );

      return false;
    } finally {
      actionInProgress = false;
    }
  }

  function sleep(milliseconds) {
    return new Promise(resolve => {
      setTimeout(resolve, milliseconds);
    });
  }


  // =========================================================
  // 단일 포인트 변화 감시
  // =========================================================

  async function monitorSingle() {
    const element =
      getElement(state.selector);

    if (!element) {
      showStatus(
        "감시 대상이 사라졌습니다.<br>" +
        "마지막 선택 위치를 두 번 터치합니다."
      );

      await doubleTouchSelectedArea();
      return;
    }

    const currentSignature =
      makeSignature(element);

    if (
      state.signature &&
      currentSignature !== state.signature
    ) {
      outline(element, "#ff3333");

      showStatus(
        `포인트 변화 감지<br>` +
        `코드: ${escapeHtml(getCode(element))}<br>` +
        `내용: ${escapeHtml(
          getText(element) || "내용 없음"
        )}<br>` +
        `<b style="color:#ffeb3b">두 번 터치합니다.</b>`
      );

      await doubleTouchSelectedArea(element);
      return;
    }

    state.signature =
      currentSignature;

    saveState();
  }


  // =========================================================
  // 범위 변화 감시
  // =========================================================

  async function monitorRegion() {
    if (!state.region) {
      return;
    }

    const currentItems =
      collectRegionItems(state.region);

    const oldItems =
      state.regionItems || {};

    let changedItem = null;
    let changeType = "";

    for (
      const key of Object.keys(currentItems)
    ) {
      if (!oldItems[key]) {
        changedItem = currentItems[key];
        changeType = "새 항목";
        break;
      }

      if (
        oldItems[key].signature !==
        currentItems[key].signature
      ) {
        changedItem = currentItems[key];
        changeType = "내용 변경";
        break;
      }
    }

    if (!changedItem) {
      for (
        const key of Object.keys(oldItems)
      ) {
        if (!currentItems[key]) {
          changedItem = oldItems[key];
          changeType = "항목 사라짐";
          break;
        }
      }
    }

    if (changedItem) {
      const changedElement =
        getElement(changedItem.selector);

      if (changedElement) {
        outline(
          changedElement,
          "#ff3333"
        );
      }

      drawRegion(
        state.region,
        "#ff3333"
      );

      showStatus(
        `범위 변화 감지: ${escapeHtml(changeType)}<br>` +
        `코드: ${escapeHtml(
          changedItem.code || "확인 불가"
        )}<br>` +
        `내용: ${escapeHtml(
          changedItem.text || "내용 없음"
        )}<br>` +
        `<b style="color:#ffeb3b">변화 부위를 두 번 터치합니다.</b>`
      );

      await doubleTouchSelectedArea(
        changedElement
      );

      return;
    }

    state.regionItems =
      currentItems;

    saveState();
  }


  // =========================================================
  // 시간 처리
  // =========================================================

  function parseTime(value) {
    if (!value) {
      return null;
    }

    const parts =
      value.split(":").map(Number);

    if (
      parts.length < 2 ||
      parts.some(Number.isNaN)
    ) {
      return null;
    }

    const hours = parts[0];
    const minutes = parts[1];
    const seconds = parts[2] || 0;

    if (
      hours < 0 ||
      hours > 23 ||
      minutes < 0 ||
      minutes > 59 ||
      seconds < 0 ||
      seconds > 59
    ) {
      return null;
    }

    return {
      hours,
      minutes,
      seconds
    };
  }

  function localDateKey(date) {
    const year =
      date.getFullYear();

    const month =
      String(date.getMonth() + 1)
        .padStart(2, "0");

    const day =
      String(date.getDate())
        .padStart(2, "0");

    return `${year}-${month}-${day}`;
  }

  function getNextSchedule() {
    const parsed =
      parseTime(state.scheduleTime);

    if (!parsed) {
      return null;
    }

    const now = new Date();
    const target = new Date(now);

    target.setHours(
      parsed.hours,
      parsed.minutes,
      parsed.seconds,
      0
    );

    const leadMilliseconds =
      Math.max(
        0,
        Number(state.leadSeconds || 0)
      ) * 1000;

    let reloadAt =
      target.getTime() -
      leadMilliseconds;

    /*
     * 오늘 예약 시간이 이미 충분히 지났으면
     * 다음 날 예약으로 계산합니다.
     */
    if (
      Date.now() >
      reloadAt + 2000
    ) {
      target.setDate(
        target.getDate() + 1
      );

      target.setHours(
        parsed.hours,
        parsed.minutes,
        parsed.seconds,
        0
      );

      reloadAt =
        target.getTime() -
        leadMilliseconds;
    }

    return {
      target,
      reloadAt,
      scheduleKey:
        `${localDateKey(target)}_` +
        `${state.scheduleTime}_` +
        `${state.leadSeconds}`
    };
  }

  function checkScheduledReload() {
    if (
      !state.enabled ||
      state.paused ||
      !state.scheduleTime ||
      actionInProgress
    ) {
      return;
    }

    const schedule =
      getNextSchedule();

    if (!schedule) {
      return;
    }

    const now = Date.now();

    if (
      now >= schedule.reloadAt &&
      now <= schedule.reloadAt + 2000 &&
      state.lastScheduleKey !==
      schedule.scheduleKey
    ) {
      state.lastScheduleKey =
        schedule.scheduleKey;

      state.pendingTouchAfterReload = true;
      state.pendingTouchReason = "schedule";

      saveState();

      showStatus(
        `${escapeHtml(state.scheduleTime)} 예약<br>` +
        `${escapeHtml(state.leadSeconds)}초 전입니다.<br>` +
        `<b style="color:#ffeb3b">새로고침 후 두 번 터치합니다.</b>`
      );

      setTimeout(() => {
        location.reload();
      }, 120);
    }
  }


  // =========================================================
  // 포인트/범위 선택
  // =========================================================

  function selectSingle(element) {
    if (
      !element ||
      isOwnElement(element)
    ) {
      return;
    }

    const clickable =
      findClickable(element);

    const target =
      clickable || element;

    const selector =
      makeSelector(target);

    if (!selector) {
      showStatus(
        "이 지점은 안정적으로 식별할 수 없습니다.<br>" +
        "조금 더 큰 버튼이나 링크를 선택해주세요."
      );

      return;
    }

    const rect =
      target.getBoundingClientRect();

    state.enabled = false;
    state.paused = false;

    state.mode = "single";
    state.selector = selector;

    state.point = {
      x: Math.round(
        rect.left + rect.width / 2
      ),
      y: Math.round(
        rect.top + rect.height / 2
      )
    };

    state.signature =
      makeSignature(target);

    state.region = null;
    state.regionItems = {};
    state.selectedAt = Date.now();

    state.pendingTouchAfterReload = false;
    state.pendingTouchReason = "";

    clearOutline();
    hideRegion();
    outline(target, "#00ff66");

    saveState();

    showStatus(
      `포인트가 지정되었습니다.<br>` +
      `코드: ${escapeHtml(getCode(target))}<br>` +
      `내용: ${escapeHtml(
        getText(target) || "내용 없음"
      )}<br>` +
      `오른쪽 ▶ 버튼을 누르세요.`
    );
  }

  function selectRegion(region) {
    if (
      region.width < 10 ||
      region.height < 10
    ) {
      const element =
        document.elementFromPoint(
          region.left +
          region.width / 2,
          region.top +
          region.height / 2
        );

      selectSingle(element);
      return;
    }

    state.enabled = false;
    state.paused = false;

    state.mode = "region";
    state.selector = null;
    state.point = null;
    state.signature = null;

    state.region = region;
    state.regionItems =
      collectRegionItems(region);

    state.selectedAt = Date.now();

    state.pendingTouchAfterReload = false;
    state.pendingTouchReason = "";

    clearOutline();
    drawRegion(region, "#00ff66");

    saveState();

    showStatus(
      `범위가 지정되었습니다.<br>` +
      `항목 ${Object.keys(
        state.regionItems
      ).length}개를 확인했습니다.<br>` +
      `오른쪽 ▶ 버튼을 누르세요.`
    );
  }


  // =========================================================
  // 터치 선택 이벤트
  // =========================================================

  let startPoint = null;
  let lastPoint = null;
  let pressStartedAt = 0;
  let pressTimer = null;
  let moved = false;
  let longPressReady = false;

  function pointFromTouch(touch) {
    return {
      x: touch.clientX,
      y: touch.clientY
    };
  }

  function clearSelectionGesture() {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }

    startPoint = null;
    lastPoint = null;
    pressStartedAt = 0;
    moved = false;
    longPressReady = false;
  }

  document.addEventListener(
    "touchstart",
    event => {
      if (
        event.touches.length !== 1 ||
        actionInProgress
      ) {
        return;
      }

      const touch =
        event.touches[0];

      const element =
        document.elementFromPoint(
          touch.clientX,
          touch.clientY
        );

      if (
        !element ||
        isOwnElement(element)
      ) {
        return;
      }

      /*
       * 중요:
       * 포인트/범위가 이미 지정된 이후에는
       * 일반 페이지 터치를 가로채지 않습니다.
       */
      if (state.mode !== null) {
        return;
      }

      startPoint =
        pointFromTouch(touch);

      lastPoint =
        pointFromTouch(touch);

      pressStartedAt =
        performance.now();

      moved = false;
      longPressReady = false;

      if (pressTimer) {
        clearTimeout(pressTimer);
      }

      pressTimer = setTimeout(() => {
        if (!startPoint) {
          return;
        }

        longPressReady = true;

        if (!moved) {
          showStatus(
            "포인트 선택 준비 완료입니다.<br>" +
            "그대로 손을 떼면 포인트가 지정됩니다."
          );
        }
      }, LONG_PRESS_TIME);
    },
    {
      capture: true,
      passive: true
    }
  );

  document.addEventListener(
    "touchmove",
    event => {
      if (
        !startPoint ||
        event.touches.length !== 1
      ) {
        return;
      }

      const current =
        pointFromTouch(event.touches[0]);

      lastPoint = current;

      const elapsed =
        performance.now() -
        pressStartedAt;

      const distance =
        Math.hypot(
          current.x - startPoint.x,
          current.y - startPoint.y
        );

      if (
        elapsed >= LONG_PRESS_TIME &&
        distance >= DRAG_DISTANCE
      ) {
        moved = true;
        longPressReady = true;

        const region =
          normalizeRegion(
            startPoint,
            current
          );

        drawRegion(
          region,
          "#00ff66"
        );

        showStatus(
          `범위 지정 중<br>` +
          `너비: ${region.width}px / ` +
          `높이: ${region.height}px<br>` +
          `원하는 위치에서 손을 떼세요.`
        );
      }
    },
    {
      capture: true,
      passive: true
    }
  );

  document.addEventListener(
    "touchend",
    event => {
      if (!startPoint) {
        return;
      }

      if (state.mode !== null) {
        clearSelectionGesture();
        return;
      }

      const elapsed =
        performance.now() -
        pressStartedAt;

      const finalPoint =
        lastPoint || startPoint;

      const distance =
        Math.hypot(
          finalPoint.x - startPoint.x,
          finalPoint.y - startPoint.y
        );

      if (elapsed < LONG_PRESS_TIME) {
        hideRegion();
        clearSelectionGesture();

        showStatus(
          "너무 빨리 손을 뗐습니다.<br>" +
          "0.7초 이상 꾹 눌러주세요."
        );

        return;
      }

      if (
        moved ||
        distance >= DRAG_DISTANCE
      ) {
        selectRegion(
          normalizeRegion(
            startPoint,
            finalPoint
          )
        );
      } else if (longPressReady) {
        const target =
          document.elementFromPoint(
            startPoint.x,
            startPoint.y
          );

        if (
          target &&
          !isOwnElement(target)
        ) {
          selectSingle(target);
        }
      }

      clearSelectionGesture();
    },
    {
      capture: true,
      passive: true
    }
  );

  document.addEventListener(
    "touchcancel",
    () => {
      hideRegion();
      clearSelectionGesture();

      if (!state.mode) {
        showStatus(
          "선택이 취소되었습니다.<br>" +
          "다시 0.7초 이상 꾹 눌러주세요."
        );
      }
    },
    {
      capture: true,
      passive: true
    }
  );

  /*
   * 길게 누를 때 Safari 기본 메뉴가 나타나는 것을 방지합니다.
   * 단, 도구 패널 내부에서는 기본 동작을 유지합니다.
   */
  document.addEventListener(
    "contextmenu",
    event => {
      if (
        state.mode === null &&
        !isOwnElement(event.target)
      ) {
        event.preventDefault();
      }
    },
    {
      capture: true
    }
  );


  // =========================================================
  // 초기 화면 복원
  // =========================================================

  createPanel();
  createControls();
  createRegionBox();

  if (
    state.mode === "region" &&
    state.region
  ) {
    drawRegion(
      state.region,
      "#00ff66"
    );
  }

  if (
    state.mode === "single" &&
    state.selector
  ) {
    const restored =
      getElement(state.selector);

    if (restored) {
      outline(
        restored,
        "#00ff66"
      );
    }
  }


  // =========================================================
  // 예약 새로고침 직후 자동 더블 터치
  // =========================================================

  if (
    state.pendingTouchAfterReload &&
    state.mode
  ) {
    showStatus(
      "예약 새로고침이 완료되었습니다.<br>" +
      `<b style="color:#ffeb3b">선택 부위를 두 번 터치합니다.</b>`
    );

    setTimeout(async () => {
      await doubleTouchSelectedArea();
    }, POST_RELOAD_DELAY);

    return;
  }


  // =========================================================
  // 초기 상태 안내
  // =========================================================

  if (
    state.enabled &&
    !state.paused &&
    state.mode
  ) {
    if (state.scheduleTime) {
      showStatus(
        `예약 감시가 복원되었습니다.<br>` +
        `시간: ${escapeHtml(state.scheduleTime)}<br>` +
        `${escapeHtml(state.leadSeconds)}초 전에 ` +
        `새로고침 후 두 번 터치합니다.`
      );
    } else {
      showStatus(
        "변화 감시가 복원되었습니다.<br>" +
        "변화가 감지되면 해당 부위를 두 번 터치합니다."
      );
    }
  } else if (
    state.paused &&
    state.mode
  ) {
    showStatus(
      "감시가 일시정지된 상태입니다.<br>" +
      "오른쪽 ▶ 버튼을 누르면 재개합니다."
    );
  } else if (state.mode) {
    showStatus(
      "선택 위치가 복원되었습니다.<br>" +
      "오른쪽 ▶ 버튼을 누르면 감시합니다."
    );
  } else {
    showStatus(
      "감시할 지점을 0.7초 이상 꾹 누르세요.<br>" +
      "누른 상태로 이동하면 범위를 지정합니다."
    );
  }


  // =========================================================
  // 감시 루프
  // =========================================================

  setInterval(async () => {
    if (
      actionInProgress ||
      !state.enabled ||
      state.paused ||
      !state.mode
    ) {
      return;
    }

    const now = Date.now();

    /*
     * 시간 설정이 있으면 예약 동작만 수행합니다.
     * 변화 감시는 실행하지 않습니다.
     */
    if (state.scheduleTime) {
      if (
        now - lastCheckTime <
        FAST_CHECK_INTERVAL
      ) {
        return;
      }

      lastCheckTime = now;
      checkScheduledReload();
      return;
    }

    /*
     * 시간이 없으면 변화 감지 모드입니다.
     */
    if (
      now - lastCheckTime <
      NORMAL_CHECK_INTERVAL
    ) {
      return;
    }

    lastCheckTime = now;

    /*
     * 페이지 로드 직후 변화를 잘못 감지하지 않도록
     * 잠시 기다린 뒤 기준 상태를 한 번 갱신합니다.
     */
    if (
      now - initializedAt <
      INITIAL_STABILIZE_TIME
    ) {
      refreshBaseline();
      return;
    }

    if (state.mode === "single") {
      await monitorSingle();
    } else if (
      state.mode === "region"
    ) {
      await monitorRegion();
    }
  }, 50);
})();
