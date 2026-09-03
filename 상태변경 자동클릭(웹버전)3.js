(function () {
    "use strict";

    if (window.__iphoneWatcherInstalled) {
        alert("이미 감시 기능이 실행 중입니다. 페이지를 새로고침한 뒤 다시 실행하세요.");
        return;
    }

    window.__iphoneWatcherInstalled = true;

    const LONG_PRESS_TIME = 700;
    const DRAG_DISTANCE = 15;
    const CHECK_INTERVAL = 500;

    const state = {
        mode: null,
        enabled: false,

        selectedElement: null,
        selector: null,
        lastSignature: null,

        region: null,
        regionItems: new Map(),

        pressTimer: null,
        pressStartX: 0,
        pressStartY: 0,
        pressCurrentX: 0,
        pressCurrentY: 0,

        longPressReady: false,
        dragging: false
    };

    function getText(element) {
        return (
            element.innerText ||
            element.textContent ||
            ""
        )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
    }

    function getCode(element) {
        return (
            element.getAttribute("data-code") ||
            element.getAttribute("data-id") ||
            element.getAttribute("data-product-code") ||
            element.getAttribute("data-item-code") ||
            element.getAttribute("data-number") ||
            element.id ||
            element.getAttribute("href") ||
            getText(element)
        );
    }

    function getElementInfo(element) {
        if (!element) {
            return null;
        }

        return {
            tag: element.tagName.toLowerCase(),
            code: getCode(element),
            id: element.id || "",
            className: typeof element.className === "string"
                ? element.className
                : "",
            text: getText(element)
        };
    }

    function escapeValue(value) {
        if (window.CSS && CSS.escape) {
            return CSS.escape(value);
        }

        return String(value).replace(
            /([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g,
            "\\$1"
        );
    }

    function makeSelector(element) {
        if (!element || element.nodeType !== 1) {
            return null;
        }

        if (element.id) {
            return "#" + escapeValue(element.id);
        }

        const path = [];
        let current = element;

        while (current && current.nodeType === 1) {
            let selector = current.tagName.toLowerCase();

            const attributes = [
                "data-code",
                "data-id",
                "data-product-code",
                "data-item-code",
                "data-number",
                "name"
            ];

            let foundAttribute = false;

            for (const attributeName of attributes) {
                const value = current.getAttribute(attributeName);

                if (value) {
                    selector +=
                        "[" +
                        attributeName +
                        '="' +
                        escapeValue(value) +
                        '"]';

                    foundAttribute = true;
                    break;
                }
            }

            if (!foundAttribute) {
                let index = 1;
                let sibling = current;

                while (sibling = sibling.previousElementSibling) {
                    if (sibling.tagName === current.tagName) {
                        index++;
                    }
                }

                selector += ":nth-of-type(" + index + ")";
            }

            path.unshift(selector);

            const candidate = path.join(" > ");

            try {
                if (document.querySelectorAll(candidate).length === 1) {
                    return candidate;
                }
            } catch (error) {
            }

            current = current.parentElement;
        }

        return path.join(" > ");
    }

    function getComputedVisualInfo(element) {
        const style = window.getComputedStyle(element);

        return {
            color: style.color,
            backgroundColor: style.backgroundColor,
            borderColor: style.borderColor,
            opacity: style.opacity,
            display: style.display,
            visibility: style.visibility,
            fontWeight: style.fontWeight
        };
    }

    function makeSignature(element) {
        if (!element) {
            return null;
        }

        const rect = element.getBoundingClientRect();

        return JSON.stringify({
            text: element.innerText || element.textContent || "",
            value: element.value || "",
            className: typeof element.className === "string"
                ? element.className
                : "",
            style: element.getAttribute("style") || "",
            outerHTML: element.outerHTML,
            disabled: !!element.disabled,
            hidden: !!element.hidden,
            visual: getComputedVisualInfo(element),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
        });
    }

    function createPanel() {
        const oldPanel = document.getElementById(
            "__iphone_watcher_panel"
        );

        if (oldPanel) {
            oldPanel.remove();
        }

        const panel = document.createElement("div");

        panel.id = "__iphone_watcher_panel";

        panel.style.position = "fixed";
        panel.style.left = "10px";
        panel.style.right = "10px";
        panel.style.bottom = "10px";
        panel.style.zIndex = "2147483647";
        panel.style.padding = "12px";
        panel.style.background = "rgba(0, 0, 0, 0.9)";
        panel.style.color = "#00ff66";
        panel.style.fontFamily = "monospace";
        panel.style.fontSize = "12px";
        panel.style.lineHeight = "1.5";
        panel.style.whiteSpace = "pre-wrap";
        panel.style.border = "1px solid #00ff66";
        panel.style.borderRadius = "8px";
        panel.style.pointerEvents = "none";

        document.documentElement.appendChild(panel);

        return panel;
    }

    function createRegionBox() {
        const oldBox = document.getElementById(
            "__iphone_watcher_region"
        );

        if (oldBox) {
            oldBox.remove();
        }

        const box = document.createElement("div");

        box.id = "__iphone_watcher_region";

        box.style.position = "fixed";
        box.style.zIndex = "2147483646";
        box.style.background = "rgba(0, 140, 255, 0.15)";
        box.style.border = "3px solid #008cff";
        box.style.pointerEvents = "none";
        box.style.display = "none";

        document.documentElement.appendChild(box);

        return box;
    }

    const panel = createPanel();
    const regionBox = createRegionBox();

    function showPanel(text) {
        panel.textContent = text;
    }

    function isPanel(element) {
        if (!element) {
            return false;
        }

        return (
            element.id === "__iphone_watcher_panel" ||
            element.id === "__iphone_watcher_region" ||
            !!element.closest("#__iphone_watcher_panel") ||
            !!element.closest("#__iphone_watcher_region")
        );
    }

    function setOutline(element, color) {
        if (!element) {
            return;
        }

        element.style.setProperty(
            "outline",
            "3px solid " + color,
            "important"
        );
    }

    function removeOutline(element) {
        if (!element) {
            return;
        }

        element.style.removeProperty("outline");
    }

    function getTouchPoint(event) {
        if (
            !event.changedTouches ||
            event.changedTouches.length === 0
        ) {
            return null;
        }

        const touch = event.changedTouches[0];

        return {
            x: touch.clientX,
            y: touch.clientY
        };
    }

    function getDistance(x1, y1, x2, y2) {
        return Math.sqrt(
            Math.pow(x2 - x1, 2) +
            Math.pow(y2 - y1, 2)
        );
    }

    function normalizeRegion(x1, y1, x2, y2) {
        return {
            left: Math.min(x1, x2),
            top: Math.min(y1, y2),
            right: Math.max(x1, x2),
            bottom: Math.max(y1, y2)
        };
    }

    function drawRegion(region) {
        regionBox.style.display = "block";
        regionBox.style.left = region.left + "px";
        regionBox.style.top = region.top + "px";
        regionBox.style.width =
            Math.max(1, region.right - region.left) + "px";
        regionBox.style.height =
            Math.max(1, region.bottom - region.top) + "px";
    }

    function hideRegion() {
        regionBox.style.display = "none";
    }

    function isVisible(element) {
        const rect = element.getBoundingClientRect();

        return (
            rect.width > 0 &&
            rect.height > 0
        );
    }

    function rectanglesIntersect(rect, region) {
        return !(
            rect.right < region.left ||
            rect.left > region.right ||
            rect.bottom < region.top ||
            rect.top > region.bottom
        );
    }

    function isIgnoredElement(element) {
        if (!element || isPanel(element)) {
            return true;
        }

        const tag = element.tagName.toLowerCase();

        return (
            tag === "html" ||
            tag === "head" ||
            tag === "body" ||
            tag === "script" ||
            tag === "style" ||
            tag === "link" ||
            tag === "meta"
        );
    }

    function collectRegionItems(region) {
        const elements = document.querySelectorAll("body *");
        const items = new Map();

        for (const element of elements) {
            if (isIgnoredElement(element)) {
                continue;
            }

            if (!isVisible(element)) {
                continue;
            }

            const rect = element.getBoundingClientRect();

            if (!rectanglesIntersect(rect, region)) {
                continue;
            }

            const selector = makeSelector(element);

            if (!selector) {
                continue;
            }

            const centerX = (
                Math.max(region.left, rect.left) +
                Math.min(region.right, rect.right)
            ) / 2;

            const centerY = (
                Math.max(region.top, rect.top) +
                Math.min(region.bottom, rect.bottom)
            ) / 2;

            const area = rect.width * rect.height;

            items.set(selector, {
                element: element,
                selector: selector,
                signature: makeSignature(element),
                centerX: centerX,
                centerY: centerY,
                area: area
            });
        }

        return items;
    }

    function findClickableElement(element) {
        if (!element) {
            return null;
        }

        const clickable = element.closest(
            "button, a, input, select, textarea, " +
            "[role='button'], [onclick], [tabindex]"
        );

        if (clickable && !isPanel(clickable)) {
            return clickable;
        }

        return element;
    }

    function clickChangedElement(item) {
        if (!item || !item.element) {
            return;
        }

        const currentElement = document.querySelector(
            item.selector
        );

        const target = findClickableElement(
            currentElement || item.element
        );

        if (!target) {
            return;
        }

        const rect = target.getBoundingClientRect();

        target.scrollIntoView({
            behavior: "smooth",
            block: "center",
            inline: "center"
        });

        setTimeout(function () {
            try {
                target.focus({
                    preventScroll: true
                });
            } catch (error) {
            }

            try {
                target.click();
            } catch (error) {
                target.dispatchEvent(
                    new MouseEvent("click", {
                        bubbles: true,
                        cancelable: true,
                        view: window,
                        clientX: rect.left + rect.width / 2,
                        clientY: rect.top + rect.height / 2
                    })
                );
            }
        }, 300);
    }

    function selectSingleElement(element) {
        if (!element || isPanel(element)) {
            return;
        }

        const info = getElementInfo(element);
        const selector = makeSelector(element);

        if (!info || !selector) {
            showPanel("선택한 요소를 확인할 수 없습니다.");
            return;
        }

        if (state.selectedElement) {
            removeOutline(state.selectedElement);
        }

        hideRegion();

        state.mode = "single";
        state.enabled = true;
        state.selectedElement = element;
        state.selector = selector;
        state.lastSignature = makeSignature(element);
        state.region = null;
        state.regionItems.clear();

        setOutline(element, "#00ff00");

        showPanel(
            "현재 상태: 단일 요소 감시 중\n" +
            "------------------------\n" +
            "코드 후보: " + info.code + "\n" +
            "태그: " + info.tag + "\n" +
            "텍스트: " + info.text + "\n" +
            "선택자: " + selector + "\n\n" +
            "같은 위치를 꾹 누르면 해제됩니다.\n" +
            "다른 위치를 꾹 누르면 새 위치로 설정됩니다.\n" +
            "꾹 누르고 드래그하면 범위 감시가 됩니다."
        );
    }

    function selectRegion(region) {
        const width = region.right - region.left;
        const height = region.bottom - region.top;

        if (width < 10 || height < 10) {
            const element = document.elementFromPoint(
                state.pressStartX,
                state.pressStartY
            );

            selectSingleElement(element);
            return;
        }

        if (state.selectedElement) {
            removeOutline(state.selectedElement);
        }

        state.mode = "region";
        state.enabled = true;
        state.selectedElement = null;
        state.selector = null;
        state.lastSignature = null;
        state.region = region;

        drawRegion(region);

        state.regionItems = collectRegionItems(region);

        showPanel(
            "현재 상태: 범위 감시 중\n" +
            "------------------------\n" +
            "범위 크기: " +
            Math.round(width) +
            " x " +
            Math.round(height) +
            "\n감시 요소 수: " +
            state.regionItems.size +
            "\n\n" +
            "범위 안의 변화가 감지되면\n" +
            "변화한 요소를 자동 클릭합니다.\n\n" +
            "같은 범위를 꾹 누르면 해제됩니다.\n" +
            "다른 위치를 꾹 누르면 새 위치로 설정됩니다."
        );
    }

    function disableMonitoring() {
        state.enabled = false;

        if (state.selectedElement) {
            removeOutline(state.selectedElement);
        }

        state.selectedElement = null;
        state.selector = null;
        state.lastSignature = null;
        state.region = null;
        state.regionItems.clear();
        state.mode = null;

        hideRegion();

        showPanel(
            "현재 상태: 감시 해제됨\n" +
            "------------------------\n" +
            "다시 꾹 누르면 새 감시 위치를 설정할 수 있습니다."
        );
    }

    function isSameSingleElement(element) {
        if (!element || !state.selector) {
            return false;
        }

        const selector = makeSelector(element);

        return selector === state.selector;
    }

    function isPointInsideRegion(x, y, region) {
        if (!region) {
            return false;
        }

        return (
            x >= region.left &&
            x <= region.right &&
            y >= region.top &&
            y <= region.bottom
        );
    }

    function isSameRegionPoint(x, y) {
        if (!state.region) {
            return false;
        }

        return isPointInsideRegion(
            x,
            y,
            state.region
        );
    }

    function processLongPress(element, x, y, wasDragged) {
        if (!element || isPanel(element)) {
            return;
        }

        if (!state.enabled) {
            if (wasDragged) {
                const region = normalizeRegion(
                    state.pressStartX,
                    state.pressStartY,
                    x,
                    y
                );

                selectRegion(region);
            } else {
                selectSingleElement(element);
            }

            return;
        }

        if (state.mode === "single") {
            if (!wasDragged && isSameSingleElement(element)) {
                disableMonitoring();
                return;
            }

            if (wasDragged) {
                const region = normalizeRegion(
                    state.pressStartX,
                    state.pressStartY,
                    x,
                    y
                );

                selectRegion(region);
                return;
            }

            selectSingleElement(element);
            return;
        }

        if (state.mode === "region") {
            if (!wasDragged && isSameRegionPoint(x, y)) {
                disableMonitoring();
                return;
            }

            if (wasDragged) {
                const region = normalizeRegion(
                    state.pressStartX,
                    state.pressStartY,
                    x,
                    y
                );

                selectRegion(region);
                return;
            }

            selectSingleElement(element);
        }
    }

    document.addEventListener(
        "touchstart",
        function (event) {
            const point = getTouchPoint(event);

            if (!point) {
                return;
            }

            const element = document.elementFromPoint(
                point.x,
                point.y
            );

            if (!element || isPanel(element)) {
                return;
            }

            state.pressStartX = point.x;
            state.pressStartY = point.y;
            state.pressCurrentX = point.x;
            state.pressCurrentY = point.y;
            state.longPressReady = false;
            state.dragging = false;

            clearTimeout(state.pressTimer);

            state.pressTimer = setTimeout(function () {
                state.longPressReady = true;

                showPanel(
                    "롱프레스 인식\n" +
                    "손을 떼면 단일 요소 설정\n" +
                    "누른 채 이동하면 범위 선택"
                );
            }, LONG_PRESS_TIME);
        },
        {
            capture: true,
            passive: true
        }
    );

    document.addEventListener(
        "touchmove",
        function (event) {
            const point = getTouchPoint(event);

            if (!point) {
                return;
            }

            state.pressCurrentX = point.x;
            state.pressCurrentY = point.y;

            if (!state.longPressReady) {
                return;
            }

            const distance = getDistance(
                state.pressStartX,
                state.pressStartY,
                point.x,
                point.y
            );

            if (distance < DRAG_DISTANCE) {
                return;
            }

            state.dragging = true;

            const region = normalizeRegion(
                state.pressStartX,
                state.pressStartY,
                point.x,
                point.y
            );

            drawRegion(region);

            showPanel(
                "범위 선택 중\n" +
                "손을 떼면 파란 사각형 범위가 감시됩니다."
            );
        },
        {
            capture: true,
            passive: true
        }
    );

    document.addEventListener(
        "touchend",
        function (event) {
            clearTimeout(state.pressTimer);
            state.pressTimer = null;

            if (!state.longPressReady) {
                return;
            }

            const point = getTouchPoint(event);

            if (!point) {
                return;
            }

            const element = document.elementFromPoint(
                point.x,
                point.y
            );

            const wasDragged = state.dragging;

            processLongPress(
                element,
                point.x,
                point.y,
                wasDragged
            );

            event.preventDefault();
            event.stopPropagation();

            state.longPressReady = false;
            state.dragging = false;
        },
        {
            capture: true,
            passive: false
        }
    );

    document.addEventListener(
        "touchcancel",
        function () {
            clearTimeout(state.pressTimer);
            state.pressTimer = null;

            state.longPressReady = false;
            state.dragging = false;

            hideRegion();
        },
        {
            capture: true,
            passive: true
        }
    );

    document.addEventListener(
        "contextmenu",
        function (event) {
            if (state.longPressReady || state.dragging) {
                event.preventDefault();
                event.stopPropagation();
            }
        },
        true
    );

    function monitorSingleElement() {
        if (!state.selectedElement || !state.selector) {
            state.enabled = false;
            return;
        }

        let currentElement = null;

        try {
            currentElement = document.querySelector(
                state.selector
            );
        } catch (error) {
            currentElement = null;
        }

        if (!currentElement) {
            state.enabled = false;

            showPanel(
                "감시 대상 요소를 찾을 수 없습니다.\n" +
                "새로운 위치를 꾹 눌러 설정하세요."
            );

            return;
        }

        state.selectedElement = currentElement;

        const currentSignature = makeSignature(
            currentElement
        );

        if (currentSignature === state.lastSignature) {
            return;
        }

        state.lastSignature = currentSignature;

        const info = getElementInfo(currentElement);

        setOutline(currentElement, "#00ff00");

        showPanel(
            "단일 요소 변경 감지\n" +
            "------------------------\n" +
            "코드 후보: " + info.code + "\n" +
            "현재 텍스트: " + info.text + "\n\n" +
            "변경된 요소를 자동 클릭합니다."
        );

        currentElement.scrollIntoView({
            behavior: "smooth",
            block: "center"
        });

        setTimeout(function () {
            try {
                currentElement.click();
            } catch (error) {
            }
        }, 400);
    }

    function chooseChangedRegionItem(oldItem, newItem) {
        if (!oldItem && newItem) {
            return newItem;
        }

        if (oldItem && !newItem) {
            return oldItem;
        }

        if (!oldItem || !newItem) {
            return null;
        }

        if (newItem.area <= oldItem.area) {
            return newItem;
        }

        return oldItem;
    }

    function monitorRegion() {
        if (!state.region) {
            state.enabled = false;
            return;
        }

        const currentItems = collectRegionItems(
            state.region
        );

        const changedItems = [];

        for (const [selector, oldItem] of state.regionItems) {
            const newItem = currentItems.get(selector);

            if (!newItem) {
                changedItems.push(oldItem);
                continue;
            }

            if (
                newItem.signature !== oldItem.signature
            ) {
                changedItems.push(
                    chooseChangedRegionItem(
                        oldItem,
                        newItem
                    )
                );
            }
        }

        for (const [selector, newItem] of currentItems) {
            if (!state.regionItems.has(selector)) {
                changedItems.push(newItem);
            }
        }

        if (changedItems.length === 0) {
            state.regionItems = currentItems;
            return;
        }

        changedItems.sort(function (a, b) {
            return a.area - b.area;
        });

        const changedItem = changedItems[0];

        state.regionItems = currentItems;

        showPanel(
            "범위 안에서 변경 감지\n" +
            "------------------------\n" +
            "변경된 항목: " +
            (changedItem.selector || "") +
            "\n\n" +
            "변경 지점을 자동 클릭합니다."
        );

        clickChangedElement(changedItem);
    }

    function monitor() {
        if (!state.enabled) {
            return;
        }

        if (state.mode === "single") {
            monitorSingleElement();
            return;
        }

        if (state.mode === "region") {
            monitorRegion();
        }
    }

    setInterval(
        monitor,
        CHECK_INTERVAL
    );

    showPanel(
        "감시 기능 준비 완료\n" +
        "------------------------\n" +
        "꾹 누르기: 단일 요소 설정\n" +
        "꾹 누른 채 드래그: 범위 설정\n" +
        "같은 위치를 다시 꾹 누르기: 해제\n" +
        "다른 위치를 꾹 누르기: 새 위치 설정"
    );
})();
