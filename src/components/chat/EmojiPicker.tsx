"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

/** [emoji, accessible name]. Plain Unicode: sent as ordinary text. */
type Emoji = readonly [string, string];

const CATEGORIES: { id: string; label: string; icon: string; emojis: Emoji[] }[] = [
  {
    id: "smileys",
    label: "Smileys",
    icon: "🙂",
    emojis: [
      ["😀", "grinning face"], ["😃", "smiling face with big eyes"], ["😄", "smiling face with smiling eyes"],
      ["😁", "beaming face"], ["😊", "smiling face with blushing cheeks"], ["🙂", "slightly smiling face"],
      ["😉", "winking face"], ["😍", "smiling face with heart eyes"], ["🥰", "smiling face with hearts"],
      ["😘", "face blowing a kiss"], ["😅", "grinning face with sweat"], ["😂", "face with tears of joy"],
      ["🤣", "rolling on the floor laughing"], ["😇", "smiling face with halo"], ["🤗", "smiling face with open hands"],
      ["🤔", "thinking face"], ["😐", "neutral face"], ["😶", "face without mouth"], ["🙄", "face with rolling eyes"],
      ["😬", "grimacing face"], ["😌", "relieved face"], ["😔", "pensive face"], ["😴", "sleeping face"],
      ["😟", "worried face"], ["🙁", "slightly frowning face"], ["😢", "crying face"], ["😭", "loudly crying face"],
      ["😮", "face with open mouth"], ["😲", "astonished face"], ["😳", "flushed face"], ["🥺", "pleading face"],
      ["😤", "face with steam from nose"], ["😠", "angry face"], ["🤯", "exploding head"], ["😎", "smiling face with sunglasses"],
      ["🤓", "nerd face"], ["🥳", "partying face"], ["😋", "face savoring food"], ["🤐", "zipper-mouth face"],
    ],
  },
  {
    id: "gestures",
    label: "Gestures and hearts",
    icon: "👍",
    emojis: [
      ["👍", "thumbs up"], ["👎", "thumbs down"], ["👌", "OK hand"], ["✌️", "victory hand"], ["🤞", "crossed fingers"],
      ["👋", "waving hand"], ["🙏", "folded hands"], ["👏", "clapping hands"], ["🙌", "raising hands"], ["🤝", "handshake"],
      ["💪", "flexed biceps"], ["👉", "backhand index pointing right"], ["👈", "backhand index pointing left"],
      ["☝️", "index pointing up"], ["👇", "backhand index pointing down"], ["✋", "raised hand"], ["🤙", "call me hand"],
      ["❤️", "red heart"], ["🧡", "orange heart"], ["💛", "yellow heart"], ["💚", "green heart"], ["💙", "blue heart"],
      ["💜", "purple heart"], ["🤍", "white heart"], ["💔", "broken heart"], ["💯", "hundred points"], ["✨", "sparkles"],
      ["🎉", "party popper"], ["🌸", "cherry blossom"], ["🌹", "rose"], ["⭐", "star"], ["🔥", "fire"],
    ],
  },
  {
    id: "health",
    label: "Health and pharmacy",
    icon: "💊",
    emojis: [
      ["💊", "pill"], ["💉", "syringe"], ["🩺", "stethoscope"], ["🩹", "adhesive bandage"], ["🌡️", "thermometer"],
      ["🩸", "drop of blood"], ["🧴", "lotion bottle"], ["🧼", "soap"], ["🧻", "roll of paper"], ["😷", "face with medical mask"],
      ["🤒", "face with thermometer"], ["🤕", "face with head-bandage"], ["🤧", "sneezing face"], ["🤢", "nauseated face"],
      ["🤮", "face vomiting"], ["🥵", "hot face"], ["🥶", "cold face"], ["😵", "face with crossed-out eyes"], ["🏥", "hospital"],
      ["🚑", "ambulance"], ["🦷", "tooth"], ["👁️", "eye"], ["👶", "baby"], ["🍼", "baby bottle"], ["🧑‍⚕️", "health worker"],
      ["🍎", "red apple"], ["🥛", "glass of milk"], ["💧", "droplet"], ["🛌", "person in bed"], ["🧘", "person in lotus position"],
    ],
  },
  {
    id: "orders",
    label: "Orders and delivery",
    icon: "📦",
    emojis: [
      ["📦", "package"], ["🚚", "delivery truck"], ["🛵", "motor scooter"], ["🏍️", "motorcycle"], ["🚗", "car"],
      ["🏠", "house"], ["🏢", "office building"], ["📍", "round pushpin"], ["🗺️", "world map"], ["🕒", "three o'clock"],
      ["⏰", "alarm clock"], ["📅", "calendar"], ["📞", "telephone receiver"], ["📱", "mobile phone"], ["💬", "speech balloon"],
      ["📝", "memo"], ["📄", "page facing up"], ["🧾", "receipt"], ["💵", "dollar banknote"], ["💳", "credit card"],
      ["🛒", "shopping cart"], ["🛍️", "shopping bags"], ["🔔", "bell"], ["🔍", "magnifying glass tilted left"], ["📷", "camera"],
    ],
  },
  {
    id: "symbols",
    label: "Symbols",
    icon: "✅",
    emojis: [
      ["✅", "check mark button"], ["✔️", "check mark"], ["❌", "cross mark"], ["❗", "red exclamation mark"],
      ["❓", "red question mark"], ["⚠️", "warning"], ["⛔", "no entry"], ["🚫", "prohibited"], ["🆗", "OK button"],
      ["🆕", "NEW button"], ["🆓", "FREE button"], ["➕", "plus"], ["➖", "minus"], ["➡️", "right arrow"],
      ["⬅️", "left arrow"], ["⬆️", "up arrow"], ["⬇️", "down arrow"], ["🔄", "counterclockwise arrows button"],
      ["⏳", "hourglass not done"], ["🔴", "red circle"], ["🟢", "green circle"], ["🔵", "blue circle"], ["🟡", "yellow circle"],
      ["ℹ️", "information"], ["♻️", "recycling symbol"],
    ],
  },
];

const COLUMNS = 8;

/**
 * Small Unicode emoji picker. Keyboard: arrow keys move between emojis,
 * Home/End jump, Enter/Space inserts, Escape closes (focus returns to the
 * trigger). Tab moves between the category tabs and the grid.
 */
export function EmojiPicker({
  onPick,
  onClose,
  className = "",
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
  className?: string;
}) {
  const [categoryId, setCategoryId] = useState(CATEGORIES[0].id);
  const [focusIndex, setFocusIndex] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const category = CATEGORIES.find((c) => c.id === categoryId) ?? CATEGORIES[0];

  // Open with focus on the first emoji.
  useEffect(() => {
    gridRef.current?.querySelector<HTMLButtonElement>("[data-emoji-index='0']")?.focus();
  }, []);

  // Close on outside pointer down.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return;
      if (e.target instanceof Element && e.target.closest("[data-emoji-trigger]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [onClose]);

  const focusAt = (i: number) => {
    const n = category.emojis.length;
    const next = Math.max(0, Math.min(n - 1, i));
    setFocusIndex(next);
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-emoji-index='${next}']`)?.focus();
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = {
      ArrowRight: focusIndex + 1,
      ArrowLeft: focusIndex - 1,
      ArrowDown: focusIndex + COLUMNS,
      ArrowUp: focusIndex - COLUMNS,
      Home: 0,
      End: category.emojis.length - 1,
    };
    if (e.key in keys) {
      e.preventDefault();
      focusAt(keys[e.key]);
    }
  };

  const onRootKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Emoji picker"
      onKeyDown={onRootKey}
      className={`flex flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop ${className}`}
      data-testid="emoji-picker"
    >
      <div className="flex gap-0.5 border-b border-line p-1.5" role="tablist" aria-label="Emoji categories">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={c.id === categoryId}
            aria-label={c.label}
            title={c.label}
            onClick={() => {
              setCategoryId(c.id);
              setFocusIndex(0);
            }}
            className={`flex h-9 flex-1 items-center justify-center rounded-lg text-lg transition ${
              c.id === categoryId ? "bg-brand-soft" : "hover:bg-subtle"
            }`}
          >
            <span aria-hidden>{c.icon}</span>
          </button>
        ))}
      </div>
      <p className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase" id="emoji-category-label">
        {category.label}
      </p>
      <div
        ref={gridRef}
        role="group"
        aria-labelledby="emoji-category-label"
        onKeyDown={onGridKey}
        className="hp-scroll grid max-h-52 grid-cols-8 gap-0.5 overflow-y-auto px-1.5 pb-2"
      >
        {category.emojis.map(([emoji, name], i) => (
          <button
            key={`${category.id}-${emoji}`}
            type="button"
            data-emoji-index={i}
            tabIndex={i === focusIndex ? 0 : -1}
            aria-label={name}
            title={name}
            onClick={() => {
              setFocusIndex(i);
              onPick(emoji);
            }}
            className="flex aspect-square items-center justify-center rounded-lg text-[22px] leading-none transition hover:bg-subtle focus-visible:bg-brand-soft"
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}

/** True for short messages made only of emoji (shown larger in the chat). */
export function isEmojiOnly(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 24) return false;
  if (!/^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|️|‍|⃣|\s)+$/u.test(trimmed)) {
    return false;
  }
  const count = trimmed.match(/\p{Extended_Pictographic}|\p{Regional_Indicator}{2}/gu)?.length ?? 0;
  return count > 0 && count <= 3;
}
