const socket = io({
    transports: ["websocket"]
});


const chat =
    document.getElementById("chat");

const status =
    document.getElementById("status");

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

const closeReport =
    document.getElementById("closeReport");

const cancelReport =
    document.getElementById("cancelReport");

const submitReport =
    document.getElementById("submitReport");


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
    status.textContent = text;

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
}


function startTimer(
    startedAt,
    duration
) {
    clearTimer();

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
            "Biraz yavaş :)"
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
            "Image must be 5 MB or smaller."
        );

        return;
    }

    if (
        Date.now() - lastSentAt <
        2000
    ) {
        addMessage(
            "Biraz yavaş :)"
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

        imgElement.alt = "Görsel";

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
    CONNECTION
*/

socket.on(
    "connect",
    () => {
        setStatus(
            "Bağlandı",
            "active"
        );
    }
);


socket.on(
    "disconnect",
    () => {
        setChatState(false);

        clearTimer();

        typing.textContent = "";

        setStatus(
            "Bağlantı kesildi"
        );

        addMessage(
            "Bağlantı koptu. Yeniden bağlanmayı deniyorum..."
        );
    }
);


/*
    MATCHMAKING
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
            data.message,
            "searching"
        );

        addMessage(
            data.message
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
            "Bir yabancı bulundu.",
            "active"
        );

        addMessage(
            "Sistem: " +
            data.message
        );

        startTimer(
            data.startedAt,
            data.duration
        );
    }
);


/*
    MESSAGES
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

        imgElement.alt = "Görsel";

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
            "Sistem: " +
            data.message
        );
    }
);


/*
    TYPING
*/

socket.on(
    "typing",
    data => {
        typing.textContent =
            data.active
                ? "Yabancı yazıyor..."
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
    SUBMIT
*/

composer.addEventListener(
    "submit",
    event => {
        event.preventDefault();

        sendMessage();
    }
);


/*
    SKIP
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
            data.message
        );

        addMessage(
            data.message
        );
    }
);


/*
    END CHAT
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
            data.message
        );

        addMessage(
            data.message
        );
    }
);


/*
    PARTNER LEFT
*/

socket.on(
    "partnerLeft",
    data => {
        setChatState(false);

        clearTimer();

        typing.textContent = "";

        setStatus(
            "Yabancı ayrıldı."
        );

        addMessage(
            data.message
        );
    }
);


/*
    NEW MATCH
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
            "Yeni bir yabancı bulabilirsin."
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
            "Yeni bir yabancı aranıyor...",
            "searching"
        );

        socket.emit(
            "findAgain"
        );
    }
);


/*
    REPORT
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
            "Sistem: " +
            data.message
        );
    }
);


socket.on(
    "reportError",
    data => {
        addMessage(
            "Sistem: " +
            data.message
        );
    }
);