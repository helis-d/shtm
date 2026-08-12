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

const socket = io({
    transports: ["websocket"],
    // Deterministic reconnect with capped attempts (no infinite storms)
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
    randomizationFactor: 0.5,
    timeout: 10000
});


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

        // Show icebreaker — once per match, only at the beginning
        const question =
            t.icebreaker(data.icebreaker);

        if (question) {
            const element =
                document.createElement("div");

            element.classList.add(
                "message",
                "message-icebreaker"
            );

            element.textContent =
                "❄️ " + question;

            chat.appendChild(element);

            chat.scrollTop =
                chat.scrollHeight;
        }
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
            "findAgain"
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
| INIT
|--------------------------------------------------------------------------
*/

// Apply initial translations after DOM is ready
updateUITexts();