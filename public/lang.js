/*
|==============================================================================
| SHTM — LANGUAGE MODULE
|==============================================================================
| i18n for SHTM. Zero-dependency, vanilla JS.
| Default: Turkish (tr). Supported: English (en).
|
| Usage:
|   t("Bir yabancı aranıyor...")  →  looks up in current language
|   t.key("connected")            →  returns translation for the given key
|   setLang("en")                 →  switches to English, saves to localStorage
|==============================================================================
*/

(function () {
    "use strict";

    const LANGS = {
        tr: {},
        en: {}
    };

    // ============================================================
    //  CLIENT-SIDE UI KEYS  (used with t.key("..."))
    // ============================================================

    const UI_TR = {
        connected: "Bağlandı",
        disconnected: "Bağlantı kesildi",
        connection_lost:
            "Bağlantı koptu. Yeniden bağlanmayı deniyorum...",
        system_prefix: "Sistem: ",
        stranger_found: "Bir yabancı bulundu.",
        stranger_typing: "Yabancı yazıyor...",
        stranger_left: "Yabancı ayrıldı.",
        find_new:
            "Yeni bir yabancı bulabilirsin.",
        searching_new:
            "Yeni bir yabancı aranıyor...",
        slow_down: "Biraz yavaş :)",
        image_alt: "Görsel",
        upload_image: "Görsel yükle",
        send_message: "Mesaj gönder",
        skip: "Atla",
        end: "Bitir",
        report: "Raporla",
        find_again: "Yeni yabancı bul",
        footer:
            "60 saniye · Bir yabancı · Bir konuşma",
        say_something: "Bir şey söyle...",
        report_title: "Bir sorun mu var?",
        report_desc:
            "Ne olduğunu kısaca anlat.",
        report_placeholder:
            "Spam, taciz, uygunsuz davranış...",
        cancel: "Vazgeç",
        submit: "Gönder",
        close: "Kapat",
        language: "Dil",
        searching_status: "Bir yabancı aranıyor..."
    };

    const UI_EN = {
        connected: "Connected",
        disconnected: "Disconnected",
        connection_lost:
            "Connection lost. Trying to reconnect...",
        system_prefix: "System: ",
        stranger_found: "A stranger was found.",
        stranger_typing: "Stranger is typing...",
        stranger_left: "Stranger left.",
        find_new:
            "You can find a new stranger.",
        searching_new:
            "Looking for a new stranger...",
        slow_down: "Slow down :)",
        image_alt: "Image",
        upload_image: "Upload image",
        send_message: "Send message",
        skip: "Skip",
        end: "End",
        report: "Report",
        find_again: "Find a stranger",
        footer:
            "60 seconds · A stranger · A conversation",
        say_something: "Say something...",
        report_title: "Is there a problem?",
        report_desc:
            "Briefly describe what happened.",
        report_placeholder:
            "Spam, harassment, inappropriate behavior...",
        cancel: "Cancel",
        submit: "Submit",
        close: "Close",
        language: "Language",
        searching_status: "Looking for a stranger..."
    };

    // ============================================================
    //  SERVER MESSAGE TRANSLATIONS  (Turkish string → English)
    //  These are the strings the server sends in Turkish.
    //  When language is "en", t() looks up the Turkish string
    //  here and returns the English equivalent.
    // ============================================================

    const SERVER_EN = {
        "Bir yabancı aranıyor...":
            "Looking for a stranger...",

        "Bir yabancıyla eşleştin.":
            "You matched with a stranger.",

        "Sohbet sona erdi.":
            "The conversation has ended.",

        "60 saniye doldu.":
            "60 seconds are up.",

        "Eşleşme atlandı.":
            "Match skipped.",

        "Yabancıyı atladın.":
            "You skipped the stranger.",

        "Karşı taraf sohbeti sonlandırdı.":
            "The other person ended the conversation.",

        "Yabancı bağlantıyı kapattı.":
            "The stranger disconnected.",

        "Rapor gönderildi.":
            "Report sent.",

        "Rapor nedeni gerekli.":
            "Report reason is required.",

        "Görsel gönderilemedi.":
            "Image could not be sent.",

        "Geçersiz görsel formatı.":
            "Invalid image format.",

        "Geçersiz görsel verisi.":
            "Invalid image data.",

        "Görsel 5 MB veya daha küçük olmalı.":
            "Image must be 5 MB or smaller.",

        "Desteklenmeyen görsel formatı.":
            "Unsupported image format.",

        "Geçersiz görsel içeriği.":
            "Invalid image content.",

        "Boş görsel gönderilemez.":
            "Empty image cannot be sent.",

        "Görsel çok büyük.":
            "Image is too large.",

        "Mesaj çok büyük.":
            "Message is too large.",

        "Çok hızlı mesaj gönderiyorsun. Biraz bekle.":
            "You're sending messages too fast. Please wait.",

        "Biraz yavaş.":
            "Slow down.",

        "Çok fazla bağlantı. Lütfen biraz bekle.":
            "Too many connections. Please wait a moment.",

        "Image must be 5 MB or smaller.":
            "Image must be 5 MB or smaller."
    };

    // ============================================================
    //  ICEBREAKER QUESTIONS (index 0–19)
    //  Picked randomly by server, displayed once per match.
    // ============================================================

    const ICEBREAKERS = [
        {
            en: "What's something you've been really into lately?",
            tr: "Son zamanlarda gerçekten ilgini çeken bir şey ne?"
        },
        {
            en: "What's a hobby you could talk about for hours?",
            tr: "Saatlerce konuşabileceğin bir hobin ne?"
        },
        {
            en: "What's the best thing you've watched recently?",
            tr: "Son zamanlarda izlediğin en iyi şey neydi?"
        },
        {
            en: "If you could instantly learn one skill, what would it be?",
            tr: "Bir beceriyi anında öğrenebilsen hangisini seçerdin?"
        },
        {
            en: "What's a small thing that always makes your day better?",
            tr: "Gününü her zaman biraz daha iyi yapan küçük bir şey nedir?"
        },
        {
            en: "What kind of music do you usually listen to?",
            tr: "Genelde ne tür müzik dinlersin?"
        },
        {
            en: "What's a game you never get tired of?",
            tr: "Oynamaktan hiç sıkılmadığın bir oyun var mı?"
        },
        {
            en: "What's a place you'd love to visit someday?",
            tr: "Bir gün mutlaka ziyaret etmek istediğin bir yer neresi?"
        },
        {
            en: "What's something random you find interesting?",
            tr: "Rastgele de olsa ilgini çeken bir şey nedir?"
        },
        {
            en: "What's something you wish more people knew about you?",
            tr: "İnsanların senin hakkında daha fazla bilmesini istediğin bir şey nedir?"
        },
        {
            en: "What's your go‑to way to relax after a long day?",
            tr: "Uzun bir günün ardından rahatlamak için en sevdiğin yöntem ne?"
        },
        {
            en: "If you could have dinner with anyone, living or dead, who would it be?",
            tr: "Yaşayan ya da ölmüş biriyle akşam yemeği yiyebilsen, kimi seçerdin?"
        },
        {
            en: "What's something you enjoyed as a kid that you still love today?",
            tr: "Çocukken sevdiğin ve bugün hâlâ sevdiğin bir şey var mı?"
        },
        {
            en: "What's the most memorable trip you've ever taken?",
            tr: "Şimdiye kadar yaptığın en unutulmaz seyahat hangisiydi?"
        },
        {
            en: "What's a food you could eat every single day?",
            tr: "Her gün yiyebileceğin bir yemek ne?"
        },
        {
            en: "What's something you're looking forward to right now?",
            tr: "Şu anda dört gözle beklediğin bir şey var mı?"
        },
        {
            en: "What's a book, movie, or show that changed the way you think?",
            tr: "Düşünce tarzını değiştiren bir kitap, film ya da dizi oldu mu?"
        },
        {
            en: "If you could live anywhere in the world, where would you choose?",
            tr: "Dünyanın herhangi bir yerinde yaşayabilseydin, nereyi seçerdin?"
        },
        {
            en: "What's something you're surprisingly good at?",
            tr: "Şaşırtıcı derecede iyi olduğun bir şey nedir?"
        },
        {
            en: "What's the best piece of advice you've ever received?",
            tr: "Şimdiye kadar aldığın en iyi tavsiye neydi?"
        }
    ];

    // Merge UI keys into LANGS
    LANGS.tr = Object.assign({}, UI_TR, SERVER_EN);
    LANGS.en = Object.assign({}, UI_EN, SERVER_EN);

    // For the `t()` function, we use the English SERVER_EN map
    // to translate server-sent Turkish strings to English.
    // We also merge UI keys so `t.key("connected")` works
    // for both languages.

    let currentLang = "tr";

    /**
     * Translate a string.
     * First checks if the text is a server message (Turkish → English lookup).
     * If not found, returns the text unchanged.
     *
     * @param {string} text — The text to translate
     * @returns {string}
     */
    function t(text) {
        if (currentLang === "tr") {
            return text;
        }

        // Look up in SERVER_EN (Turkish → English)
        if (SERVER_EN.hasOwnProperty(text)) {
            return SERVER_EN[text];
        }

        return text;
    }

    /**
     * Get an icebreaker question for the current language.
     * @param {number} index — 0-19
     * @returns {string}
     */
    t.icebreaker = function (index) {
        const question = ICEBREAKERS[index];
        if (!question) {
            return "";
        }
        // Prefer current language, fall back to Turkish
        return question[currentLang] || question.tr || "";
    };

    /**
     * Translate a client-side UI key.
     *
     * @param {string} key — The translation key (e.g. "connected")
     * @returns {string}
     */
    t.key = function (key) {
        const map = LANGS[currentLang];
        if (map && map.hasOwnProperty(key)) {
            return map[key];
        }
        // Fallback to Turkish
        return LANGS.tr[key] || key;
    };

    /**
     * Get the current language code.
     * @returns {string} "tr" or "en"
     */
    t.lang = function () {
        return currentLang;
    };

    /**
     * Set the language and persist to localStorage.
     * Triggers a custom event so the app can re-render.
     *
     * @param {string} lang — "tr" or "en"
     */
    window.setLang = function (lang) {
        if (lang !== "tr" && lang !== "en") {
            return;
        }
        currentLang = lang;
        try {
            localStorage.setItem("shtm_lang", lang);
        } catch (_) { /* ignore */ }
        document.documentElement.lang = lang;
        window.dispatchEvent(new CustomEvent("langChange", { detail: { lang } }));
    };

    // Initialize from localStorage
    try {
        const saved = localStorage.getItem("shtm_lang");
        if (saved === "en" || saved === "tr") {
            currentLang = saved;
        }
    } catch (_) { /* ignore */ }

    document.documentElement.lang = currentLang;

    // Expose to global scope
    window.t = t;
    window.__LANGS = LANGS;
    window.__SERVER_EN = SERVER_EN;
    window.__ICEBREAKERS = ICEBREAKERS;
})();