/*
|==============================================================================
| SHTM — CLIENT APPLICATION
|==============================================================================
| Socket.IO client, UI rendering, event handling.
| Uses t() / t.key() from lang.js for i18n.
|==============================================================================
*/

/*
|--------------------------------------------------------------------------
| CLIENT CONNECTION STATE
|--------------------------------------------------------------------------
| Explicit lifecycle: connecting → connected → reconnecting → disconnected.
| Surfaced to the user so the interface never silently freezes.
|--------------------------------------------------------------------------
*/

const CONNECTION_STATE = {
    CONNECTING: "connecting",
    CONNECTED: "connected",
    RECONNECTING: "reconnecting",
    DISCONNECTED: "disconnected"
};

let connectionState = CONNECTION_STATE.CONNECTING;

function setConnectionState(state) {
    connectionState = state;
}

/*
|--------------------------------------------------------------------------
| GROWTH / ATTRIBUTION CONTEXT
|--------------------------------------------------------------------------
| Privacy-preserving attribution only. No fingerprinting, no cross-site
| tracking. We pass along:
|   - vid        : a random, non-identifying visitor token (localStorage)
|   - ref        : document.referrer (for referrer forensics)
|   - utm_*      : UTM campaign params (for campaign measurement)
|   - landing    : current pathname (cohort/campaign landing page)
|
| UTM params are persisted through the session so a later share keeps the
| original campaign association.
|--------------------------------------------------------------------------
*/

const VID_STORAGE_KEY = "shtm_vid";
const UTM_STORAGE_KEY = "shtm_utm";

function getVisitorId() {
    try {
        let vid = localStorage.getItem(VID_STORAGE_KEY);
        if (!vid) {
            vid =
                "v_" +
                Date.now().toString(36) +
                "_" +
                Math.random().toString(36).slice(2, 12);
            localStorage.setItem(VID_STORAGE_KEY, vid);
        }
        return vid;
    } catch (_) {
        return "";
    }
}

function readUtmParams() {
    const query = new URLSearchParams(window.location.search);
    const utm = {
        source: query.get("utm_source") || "",
        medium: query.get("utm_medium") || "",
        campaign: query.get("utm_campaign") || ""
    };

    // Persist if present.
    if (utm.source || utm.medium || utm.campaign) {
        try {
            localStorage.setItem(UTM_STORAGE_KEY, JSON.stringify(utm));
        } catch (_) {
            /* ignore */
        }
        return utm;
    }

    // Otherwise restore persisted campaign association.
    try {
        const saved = localStorage.getItem(UTM_STORAGE_KEY);
        if (saved) return JSON.parse(saved) || utm;
    } catch (_) {
        /* ignore */
    }

    return utm;
}

const attribution = readUtmParams();

const socket = io({
    transports: ["websocket"],
    // Deterministic reconnect with capped attempts (no infinite storms)
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
    randomizationFactor: 0.5,
    timeout: 10000,
    query: {
        vid: getVisitorId(),
        ref: document.referrer || "",
        utm_source: attribution.source || "",
        utm_medium: attribution.medium || "",
        utm_campaign: attribution.campaign || "",
        landing: window.location.pathname || "/"
    }
});

// Feature flags + interest catalog fetched once at startup.
const feature = { interests: true, icebreakers: true, nextMatch: true, onlineCount: true };
let interestCatalog = [];
let eligibleCount = 0;
let selectedInterests = [];


const chat =
    document.getElementById("chat");

const status =
    document.getElementById("status");

const statusText =
    document.getElementById("statusText");

const timer =
    document.getElementById("timer");

const input =
    document.getElementById("messageInput");

const sendButton =
    document.getElementById("sendButton");

const composer =
    document.getElementById("composer");

const skipButton =
    document.getElementById("skipButton");

const endButton =
    document.getElementById("endButton");

const reportButton =
    document.getElementById("reportButton");

const findAgainButton =
    document.getElementById("findAgainButton");

const shareButton =
    document.getElementById("shareButton");

const typing =
    document.getElementById("typing");


const imageButton =
    document.getElementById("imageButton");

const imageInput =
    document.getElementById("imageInput");


const reportModal =
    document.getElementById("reportModal");

const reportInput =
    document.getElementById("reportInput");

const reportTitle =
    reportModal.querySelector("h2");

const reportDesc =
    reportModal.querySelector(".modal-description");

const closeReport =
    document.getElementById("closeReport");

const cancelReport =
    document.getElementById("cancelReport");

const submitReport =
    document.getElementById("submitReport");


const langToggle =
    document.getElementById("langToggle");


const footer =
    document.querySelector("footer");


const msgInput =
    document.getElementById("messageInput");


const interestPicker =
    document.getElementById("interestPicker");

const interestChips =
    document.getElementById("interestChips");

const interestSkip =
    document.getElementById("interestSkip");

const interestSave =
    document.getElementById("interestSave");

const introCard =
    document.getElementById("introCard");

const introProfile =
    document.getElementById("introProfile");

const sharedInterests =
    document.getElementById("sharedInterests");

const icebreakerNext =
    document.getElementById("icebreakerNext");

const onlineCount =
    document.getElementById("onlineCount");


let inChat = false;

let countdown = null;

let typingTimeout = null;

let isTyping = false;

let lastSentAt = 0;


function addMessage(
    text,
    type = "system"
) {
    const element =
        document.createElement("div");

    element.classList.add(
        "message"
    );

    if (type === "me") {
        element.classList.add(
            "message-me"
        );
    }

    else if (type === "other") {
        element.classList.add(
            "message-other"
        );
    }

    else {
        element.classList.add(
            "message-system"
        );
    }

    element.textContent = text;

    chat.appendChild(element);

    chat.scrollTop =
        chat.scrollHeight;
}


function setStatus(
    text,
    type = ""
) {
    statusText.textContent = text;

    status.className =
        "status";

    if (type) {
        status.classList.add(type);
    }
}


function setChatState(
    enabled
) {
    inChat = enabled;

    input.disabled =
        !enabled;

    sendButton.disabled =
        !enabled;

    imageButton.disabled =
        !enabled;

    skipButton.disabled =
        !enabled;

    endButton.disabled =
        !enabled;

    reportButton.disabled =
        !enabled;

    if (enabled) {
        input.focus();
    }
}


function clearTimer() {
    if (countdown) {
        clearInterval(
            countdown
        );

        countdown = null;
    }

    timer.textContent = "";
    timer.classList.add("hidden");
}


function startTimer(
    startedAt,
    duration
) {
    clearTimer();

    timer.classList.remove("hidden");

    const endTime =
        startedAt + duration;

    function update() {
        const remaining =
            Math.max(
                0,
                endTime - Date.now()
            );

        const seconds =
            Math.ceil(
                remaining / 1000
            );

        timer.textContent =
            `${seconds}s`;

        if (seconds <= 5) {
            timer.style.background =
                "#ffb7c8";
        }
        else {
            timer.style.background =
                "#ffd95e";
        }

        if (remaining <= 0) {
            clearTimer();
        }
    }

    update();

    countdown =
        setInterval(
            update,
            100
        );
}


function setTyping(
    active
) {
    if (!inChat) {
        return;
    }

    if (isTyping === active) {
        return;
    }

    isTyping = active;

    socket.emit(
        "typing",
        active
    );
}


function sendMessage() {
    if (!inChat) {
        return;
    }

    const message =
        input.value.trim();

    if (!message) {
        return;
    }

    if (message.length > 500) {
        return;
    }

    if (
        Date.now() - lastSentAt <
        2000
    ) {
        addMessage(
            t.key("slow_down")
        );

        return;
    }

    lastSentAt =
        Date.now();

    socket.emit(
        "sendMessage",
        {
            message
        }
    );

    addMessage(
        message,
        "me"
    );

    input.value = "";

    setTyping(false);
}


function sendImage(file) {
    if (!inChat) {
        return;
    }

    const MAX_SIZE =
        5 * 1024 * 1024;

    if (file.size > MAX_SIZE) {
        addMessage(
            t("Image must be 5 MB or smaller.")
        );

        return;
    }

    if (
        Date.now() - lastSentAt <
        2000
    ) {
        addMessage(
            t.key("slow_down")
        );

        return;
    }

    const reader =
        new FileReader();

    reader.onload = () => {
        const base64 =
            reader.result;

        if (
            typeof base64 !== "string"
        ) {
            return;
        }

        lastSentAt = Date.now();

        socket.emit(
            "sendImage",
            {
                image: base64
            }
        );

        const imgElement =
            document.createElement(
                "img"
            );

        imgElement.src = base64;

        imgElement.alt =
            t.key("image_alt");

        imgElement.classList.add(
            "message-image"
        );

        imgElement.loading =
            "lazy";

        const wrapper =
            document.createElement(
                "div"
            );

        wrapper.classList.add(
            "message",
            "message-me"
        );

        wrapper.appendChild(
            imgElement
        );

        chat.appendChild(
            wrapper
        );

        chat.scrollTop =
            chat.scrollHeight;
    };

    reader.readAsDataURL(file);
}


function openReport() {
    reportModal.classList.remove(
        "hidden"
    );

    reportInput.value = "";

    reportInput.focus();
}


function closeReportModal() {
    reportModal.classList.add(
        "hidden"
    );
}


/*
|--------------------------------------------------------------------------
| LANGUAGE TOGGLE
|--------------------------------------------------------------------------
*/

function updateUITexts() {
    const lang = t.lang();

    // Timer is just numbers — no update needed

    // Buttons
    langToggle.textContent =
        lang === "tr" ? "TR" : "EN";

    langToggle.title =
        lang === "tr"
            ? "Dil değiştir / Change language"
            : "Change language / Dil değiştir";

    langToggle.setAttribute(
        "aria-label",
        lang === "tr"
            ? "Dil değiştir"
            : "Change language"
    );

    sendButton.setAttribute(
        "aria-label",
        t.key("send_message")
    );

    imageButton.setAttribute(
        "aria-label",
        t.key("upload_image")
    );

    imageButton.setAttribute(
        "title",
        t.key("upload_image")
    );

    skipButton.textContent =
        t.key("skip");

    endButton.textContent =
        t.key("end");

    reportButton.textContent =
        t.key("report");

    findAgainButton.textContent =
        t.key("find_again");

    shareButton.textContent =
        t.key("share");

    // Input placeholder
    msgInput.setAttribute(
        "placeholder",
        t.key("say_something")
    );

    // Footer
    footer.textContent =
        t.key("footer");

    // Report modal
    reportTitle.textContent =
        t.key("report_title");

    reportDesc.textContent =
        t.key("report_desc");

    reportInput.setAttribute(
        "placeholder",
        t.key("report_placeholder")
    );

    cancelReport.textContent =
        t.key("cancel");

    submitReport.textContent =
        t.key("submit");

    closeReport.setAttribute(
        "aria-label",
        t.key("close")
    );

    // Status — trigger the right event to get status text
    // (matches the event logic below)
}

langToggle.addEventListener(
    "click",
    () => {
        const next =
            t.lang() === "tr"
                ? "en"
                : "tr";

        setLang(next);
    }
);

window.addEventListener(
    "langChange",
    () => {
        updateUITexts();

        // Re-translate the current status if it's a search status
        if (
            status.classList.contains(
                "searching"
            )
        ) {
            setStatus(
                t.key("searching_status"),
                "searching"
            );
        }
    }
);


/*
|--------------------------------------------------------------------------
| CONNECTION
|--------------------------------------------------------------------------
*/

socket.on(
    "connect",
    () => {
        setConnectionState(
            CONNECTION_STATE.CONNECTED
        );

        setStatus(
            t.key("connected"),
            "active"
        );
    }
);


socket.on(
    "connect_error",
    (err) => {
        setConnectionState(
            CONNECTION_STATE.DISCONNECTED
        );

        setStatus(
            t.key("disconnected")
        );
    }
);


socket.io.on(
    "reconnect_attempt",
    () => {
        setConnectionState(
            CONNECTION_STATE.RECONNECTING
        );

        setStatus(
            t.key("reconnecting"),
            "searching"
        );

        addMessage(
            t.key("reconnecting")
        );
    }
);


socket.io.on(
    "reconnect",
    () => {
        setConnectionState(
            CONNECTION_STATE.CONNECTED
        );

        setStatus(
            t.key("connected"),
            "active"
        );
    }
);


socket.io.on(
    "reconnect_failed",
    () => {
        setConnectionState(
            CONNECTION_STATE.DISCONNECTED
        );

        setStatus(
            t.key("disconnected")
        );
    }
);


socket.on(
    "disconnect",
    (reason) => {
        setConnectionState(
            CONNECTION_STATE.DISCONNECTED
        );

        setChatState(false);

        clearTimer();

        typing.textContent = "";

        setStatus(
            t.key("disconnected")
        );

        addMessage(
            t.key("connection_lost")
        );
    }
);


// Server round-trip latency ping (see api/index.js system:ping)
socket.on(
    "system:ping",
    (data) => {
        socket.emit("system:pong", {
            t: data && data.t
        });
    }
);


/*
|--------------------------------------------------------------------------
| MATCHMAKING
|--------------------------------------------------------------------------
*/

socket.on(
    "searching",
    data => {
        setChatState(false);

        clearTimer();

        findAgainButton.classList.add(
            "hidden"
        );

        setStatus(
            t(data.message),
            "searching"
        );

        addMessage(
            t(data.message)
        );
    }
);


socket.on(
    "matched",
    data => {
        setChatState(true);

        findAgainButton.classList.add(
            "hidden"
        );

        setStatus(
            t.key("stranger_found"),
            "active"
        );

        addMessage(
            t.key("system_prefix") +
            t(data.message)
        );

        startTimer(
            data.startedAt,
            data.duration
        );
    }
);


/*
|--------------------------------------------------------------------------
| MESSAGES
|--------------------------------------------------------------------------
*/

socket.on(
    "message",
    data => {
        addMessage(
            data.message,
            "other"
        );
    }
);


socket.on(
    "image",
    data => {
        if (
            !data ||
            typeof data.image !==
                "string"
        ) {
            return;
        }

        const imgElement =
            document.createElement(
                "img"
            );

        imgElement.src =
            data.image;

        imgElement.alt =
            t.key("image_alt");

        imgElement.classList.add(
            "message-image"
        );

        imgElement.loading =
            "lazy";

        const wrapper =
            document.createElement(
                "div"
            );

        wrapper.classList.add(
            "message",
            "message-other"
        );

        wrapper.appendChild(
            imgElement
        );

        chat.appendChild(
            wrapper
        );

        chat.scrollTop =
            chat.scrollHeight;
    }
);


socket.on(
    "messageError",
    data => {
        addMessage(
            t.key("system_prefix") +
            t(data.message)
        );
    }
);


/*
|--------------------------------------------------------------------------
| TYPING
|--------------------------------------------------------------------------
*/

socket.on(
    "typing",
    data => {
        typing.textContent =
            data.active
                ? t.key("stranger_typing")
                : "";
    }
);


imageButton.addEventListener(
    "click",
    () => {
        if (!inChat) {
            return;
        }

        imageInput.click();
    }
);


imageInput.addEventListener(
    "change",
    () => {
        const file =
            imageInput.files[0];

        if (!file) {
            return;
        }

        sendImage(file);

        imageInput.value = "";
    }
);


input.addEventListener(
    "input",
    () => {
        setTyping(true);

        clearTimeout(
            typingTimeout
        );

        typingTimeout =
            setTimeout(
                () => {
                    setTyping(false);
                },
                800
            );
    }
);


/*
|--------------------------------------------------------------------------
| SUBMIT
|--------------------------------------------------------------------------
*/

composer.addEventListener(
    "submit",
    event => {
        event.preventDefault();

        sendMessage();
    }
);


/*
|--------------------------------------------------------------------------
| SKIP
|--------------------------------------------------------------------------
*/

skipButton.addEventListener(
    "click",
    () => {
        if (!inChat) {
            return;
        }

        socket.emit("skip");
    }
);


socket.on(
    "skipped",
    data => {
        setChatState(false);

        clearTimer();

        setStatus(
            t(data.message)
        );

        addMessage(
            t(data.message)
        );
    }
);


/*
|--------------------------------------------------------------------------
| END CHAT
|--------------------------------------------------------------------------
*/

endButton.addEventListener(
    "click",
    () => {
        if (!inChat) {
            return;
        }

        socket.emit(
            "endChat"
        );
    }
);


socket.on(
    "roomEnded",
    data => {
        setChatState(false);

        clearTimer();

        typing.textContent = "";

        setStatus(
            t(data.message)
        );

        addMessage(
            t(data.message)
        );
    }
);


/*
|--------------------------------------------------------------------------
| PARTNER LEFT
|--------------------------------------------------------------------------
*/

socket.on(
    "partnerLeft",
    data => {
        setChatState(false);

        clearTimer();

        typing.textContent = "";

        setStatus(
            t.key("stranger_left")
        );

        addMessage(
            t(data.message)
        );
    }
);


/*
|--------------------------------------------------------------------------
| NEW MATCH
|--------------------------------------------------------------------------
*/

socket.on(
    "readyForNewMatch",
    () => {
        setChatState(false);

        clearTimer();

        findAgainButton.classList.remove(
            "hidden"
        );

        setStatus(
            t.key("find_new")
        );
    }
);


findAgainButton.addEventListener(
    "click",
    () => {
        chat.replaceChildren();

        findAgainButton.classList.add(
            "hidden"
        );

        setStatus(
            t.key("searching_new"),
            "searching"
        );

        socket.emit(
            "queue:next"
        );
    }
);


/*
|--------------------------------------------------------------------------
| REPORT
|--------------------------------------------------------------------------
*/

reportButton.addEventListener(
    "click",
    openReport
);


closeReport.addEventListener(
    "click",
    closeReportModal
);


cancelReport.addEventListener(
    "click",
    closeReportModal
);


submitReport.addEventListener(
    "click",
    () => {
        const reason =
            reportInput.value.trim();

        if (!reason) {
            return;
        }

        socket.emit(
            "report",
            {
                reason
            }
        );

        closeReportModal();
    }
);


socket.on(
    "reportSent",
    data => {
        addMessage(
            t.key("system_prefix") +
            t(data.message)
        );
    }
);


socket.on(
    "reportError",
    data => {
        addMessage(
            t.key("system_prefix") +
            t(data.message)
        );
    }
);


/*
|--------------------------------------------------------------------------
| SHARE / REFERRAL (attribution)
|--------------------------------------------------------------------------
| Share a link that carries the current campaign metadata (UTM) so the next
| visitor's session retains the campaign association. Lightweight attribution
| only — no full referral system.
|--------------------------------------------------------------------------
*/

function buildShareUrl() {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";

    if (attribution.source) {
        url.searchParams.set("utm_source", attribution.source);
    }
    if (attribution.medium) {
        url.searchParams.set("utm_medium", attribution.medium);
    }
    if (attribution.campaign) {
        url.searchParams.set("utm_campaign", attribution.campaign);
    }

    return url.toString();
}

shareButton.addEventListener("click", async () => {
    const shareUrl = buildShareUrl();

    try {
        if (navigator.share) {
            await navigator.share({
                title: "SHTM — Say Hello To Me",
                text: t.key("share_text"),
                url: shareUrl
            });
            addMessage(t.key("share_success"));
            return;
        }
    } catch (err) {
        // User cancelled the share sheet — fall through to clipboard.
        if (err && err.name === "AbortError") {
            return;
        }
    }

    try {
        await navigator.clipboard.writeText(shareUrl);
        addMessage(t.key("share_copied"));
    } catch (_) {
        addMessage(shareUrl);
    }
});


/*
|--------------------------------------------------------------------------
| FEATURE WAVE UI
|--------------------------------------------------------------------------
*/

const MAX_INTERESTS = 5;

function renderInterestChips() {
    interestChips.innerHTML = "";

    for (const interest of interestCatalog) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "interest-chip";
        chip.textContent = interest.label;
        chip.setAttribute("role", "checkbox");
        chip.setAttribute("aria-checked", "false");
        chip.dataset.id = interest.id;

        chip.addEventListener("click", () => {
            if (chip.classList.contains("selected")) {
                chip.classList.remove("selected");
                chip.setAttribute("aria-checked", "false");
                selectedInterests = selectedInterests.filter(
                    (id) => id !== interest.id
                );
            } else if (selectedInterests.length < MAX_INTERESTS) {
                chip.classList.add("selected");
                chip.setAttribute("aria-checked", "true");
                selectedInterests.push(interest.id);
            }
        });

        interestChips.appendChild(chip);
    }
}

function showInterestPicker() {
    if (!feature.interests) return;
    interestPicker.classList.remove("hidden");
    renderInterestChips();
}

function hideInterestPicker() {
    interestPicker.classList.add("hidden");
}

function submitInterests(interests) {
    selectedInterests = interests;
    socket.emit("interests:set", interests);
    hideInterestPicker();
}

interestSkip.addEventListener("click", () => {
    submitInterests([]);
});

interestSave.addEventListener("click", () => {
    submitInterests(selectedInterests.slice());
});

function countryFlag(code) {
    if (!code) return "🌍";
    const base = 0x1f1e6;
    const cc = code.toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) return "🌍";
    const cp = cc
        .split("")
        .map((c) => base + (c.charCodeAt(0) - 65));
    return String.fromCodePoint(...cp);
}

function renderIntro(data) {
    introCard.classList.remove("hidden");

    const partner = data.partner || {};
    const tags = [];

    if (partner.country) {
        tags.push(countryFlag(partner.country) + " " + (partner.country || ""));
    }
    if (partner.language) {
        tags.push(partner.language);
    }
    for (const id of partner.interests || []) {
        const match = interestCatalog.find((i) => i.id === id);
        if (match) tags.push(match.label);
    }

    introProfile.innerHTML = tags
        .slice(0, 8)
        .map((t) => '<span class="intro-tag">' + escapeHtml(t) + "</span>")
        .join("");

    const shared = data.sharedInterests || [];
    if (shared.length > 0) {
        const labels = shared
            .slice(0, 3)
            .map((id) => {
                const m = interestCatalog.find((i) => i.id === id);
                return m ? m.label : id;
            })
            .join(", ");
        sharedInterests.textContent = "You both like " + labels + ".";
        sharedInterests.classList.remove("hidden");
    } else {
        sharedInterests.classList.add("hidden");
    }
}

function hideIntroCard() {
    introCard.classList.add("hidden");
    icebreakerNext.classList.add("hidden");
}

function showIcebreaker(q) {
    if (!q) return;
    icebreakerNext.classList.remove("hidden");
    const el = document.createElement("div");
    el.classList.add("message", "message-icebreaker");
    el.textContent = "❄️ " + q.text;
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = String(str == null ? "" : str);
    return div.innerHTML;
}

function showFeedback() {
    // Minimal inline feedback injected into the chat area after a conversation.
    const wrap = document.createElement("div");
    const label = document.createElement("div");
    label.className = "message message-system";
    label.textContent = "How was the conversation?";
    wrap.appendChild(label);

    for (const [key, text] of Object.entries({ good: "Good", okay: "Okay", not_great: "Not great" })) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "interest-chip";
        btn.textContent = text;
        btn.addEventListener("click", () => {
            socket.emit("conversation:feedback", { rating: key });
            wrap.remove();
        });
        wrap.appendChild(btn);
    }

    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
}

function updateOnlineCount() {
    if (!feature.onlineCount) {
        onlineCount.classList.add("hidden");
        return;
    }

    if (eligibleCount === 0) {
        onlineCount.classList.add("hidden");
        return;
    }

    onlineCount.textContent = eligibleCount + " people online";
    onlineCount.classList.remove("hidden");
}

/* Server → client feature events */

socket.on("presence", (data) => {
    eligibleCount = Number(data && data.eligible) || 0;
    updateOnlineCount();
});

socket.on("match:intro", (data) => {
    renderIntro(data);
});

socket.on("conversation:icebreaker", (q) => {
    showIcebreaker(q);
});

socket.on("conversation:milestone", (data) => {
    // Subtle UX: do not spam. Only surface the first milestone.
    if (data && data.level === 1) {
        addMessage("Nice conversation.");
    }
});

socket.on("conversation:ended", () => {
    hideIntroCard();
    showFeedback();
});

socket.on("share:prompt", () => {
    addMessage("Want to bring a friend to SHTM?");
});

socket.on("session:summary", (data) => {
    const n = Number(data && data.conversations) || 0;
    if (n > 0) {
        addMessage("Conversation " + n);
    }
});

icebreakerNext.addEventListener("click", () => {
    socket.emit("icebreaker:next");
});

/* Match start reset */
socket.on("matched", () => {
    hideIntroCard();
});

/* Load feature flags + interest catalog */
async function loadFeatures() {
    try {
        const res = await fetch("/api/features");
        if (!res.ok) return;
        const data = await res.json();
        if (data.flags) {
            feature.interests = data.flags.interests !== false;
            feature.icebreakers = data.flags.icebreakers !== false;
            feature.nextMatch = data.flags.nextMatch !== false;
            feature.onlineCount = data.flags.onlineCount !== false;
        }
        if (Array.isArray(data.interests)) {
            interestCatalog = data.interests;
        }
        showInterestPicker();
    } catch (_) {
        /* feature API optional */
    }
}

loadFeatures();

/*
|--------------------------------------------------------------------------
| INIT
|--------------------------------------------------------------------------
*/

// Apply initial translations after DOM is ready
updateUITexts();
