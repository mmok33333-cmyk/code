(function () {
    "use strict";

    if (window.__iphoneWatcherInstalled) {
        alert("이미 감시 기능이 실행 중입니다.");
        return;
    }

    window.__iphoneWatcherInstalled = true;

    const state = {
        selectedElement: null,
        selector: null,
        lastSignature: null,
        lastTapTime: 0,
        lastTapX: 0,
        lastTapY: 0,
        running: false
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

        const attributes = {};

        for (const attr of element.attributes) {
            attributes[attr.name] = attr.value;
        }

        return {
            tag: element.tagName.toLowerCase(),
            code: getCode(element),
            id: element.id || "",
            className: typeof element.className === "string"
                ? element.className
                : "",
            text: getText(element),
            attributes: attributes
        };
    }

    function escapeValue(value) {
        if (window.CSS && CSS.escape) {
            return CSS.escape(value);
        }

        return String(value).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
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

    function makeSignature(element) {
        if (!element) {
            return null;
        }

        return JSON.stringify({
            outerHTML: element.outerHTML,
            text: element.innerText || element.textContent || "",
            className: typeof element.className === "string"
                ? element.className
                : "",
            style: element.getAttribute("style") || "",
            value: element.value || "",
            disabled: !!element.disabled,
            hidden: !!element.hidden,
            attributes: Array.from(element.attributes).map(function (attr) {
                return [
                    attr.name,
                    attr.value
                ];
            })
        });
    }

    function findCurrentElement() {
        if (!state.selector) {
            return null;
        }

        try {
            return document.querySelector(state.selector);
        } catch (error) {
            return null;
        }
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

    const panel = createPanel();

    function showPanel(text) {
        panel.textContent = text;
    }

    function highlightElement(element) {
        if (!element) {
            return;
        }

        element.style.setProperty(
            "outline",
            "3px solid red",
            "important"
        );
    }

    function removeHighlight(element) {
        if (!element) {
            return;
        }

        element.style.removeProperty("outline");
    }

    function selectElement(element, x, y) {
        if (!element) {
            return;
        }

        const info = getElementInfo(element);
        const selector = makeSelector(element);

        if (!info || !selector) {
            showPanel("요소를 확인할 수 없습니다.");
            return;
        }

        if (state.selectedElement) {
            removeHighlight(state.selectedElement);
        }

        state.selectedElement = element;
        state.selector = selector;
        state.lastSignature = makeSignature(element);
        state.running = true;

        highlightElement(element);

        showPanel(
            "감시 시작\n" +
            "------------------------\n" +
            "태그: " + info.tag + "\n" +
            "코드 후보: " + info.code + "\n" +
            "id: " + info.id + "\n" +
            "class: " + info.className + "\n" +
            "텍스트: " + info.text + "\n" +
            "선택자: " + selector + "\n\n" +
            "상태가 바뀌면 자동 클릭합니다."
        );
    }

    function handleDoubleTap(event) {
        const now = Date.now();

        const touch =
            event.changedTouches &&
            event.changedTouches.length > 0
                ? event.changedTouches[0]
                : null;

        if (!touch) {
            return;
        }

        const x = touch.clientX;
        const y = touch.clientY;

        const timeDifference = now - state.lastTapTime;

        const distance = Math.sqrt(
            Math.pow(x - state.lastTapX, 2) +
            Math.pow(y - state.lastTapY, 2)
        );

        const isDoubleTap =
            timeDifference > 0 &&
            timeDifference < 400 &&
            distance < 40;

        state.lastTapTime = now;
        state.lastTapX = x;
        state.lastTapY = y;

        if (!isDoubleTap) {
            return;
        }

        const element = document.elementFromPoint(x, y);

        if (!element) {
            return;
        }

        if (
            element.id === "__iphone_watcher_panel" ||
            element.closest("#__iphone_watcher_panel")
        ) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        selectElement(element, x, y);
    }

    document.addEventListener(
        "touchend",
        handleDoubleTap,
        true
    );

    function monitor() {
        if (!state.running) {
            return;
        }

        const currentElement = findCurrentElement();

        if (!currentElement) {
            state.running = false;

            showPanel(
                "감시 대상 요소를 찾을 수 없습니다.\n" +
                "페이지 구조가 변경되었을 수 있습니다."
            );

            return;
        }

        const currentSignature = makeSignature(currentElement);

        if (currentSignature === state.lastSignature) {
            return;
        }

        state.lastSignature = currentSignature;

        const info = getElementInfo(currentElement);

        showPanel(
            "변경 감지\n" +
            "------------------------\n" +
            "코드 후보: " + info.code + "\n" +
            "태그: " + info.tag + "\n" +
            "현재 텍스트: " + info.text + "\n\n" +
            "현재 요소를 자동 클릭합니다."
        );

        removeHighlight(currentElement);

        currentElement.scrollIntoView({
            behavior: "smooth",
            block: "center"
        });

        setTimeout(function () {
            try {
                currentElement.click();
            } catch (error) {
                showPanel(
                    "변경은 감지했지만 클릭하지 못했습니다.\n" +
                    error.message
                );
            }
        }, 300);
    }

    setInterval(monitor, 500);

    showPanel(
        "감시 기능 준비 완료\n" +
        "------------------------\n" +
        "원하는 버튼이나 항목을 두 번 터치하세요."
    );
})();

