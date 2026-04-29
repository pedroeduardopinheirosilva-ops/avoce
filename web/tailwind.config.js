/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans:  ["Inter", "system-ui", "sans-serif"],
        serif: ["Instrument Serif", "Georgia", "serif"],
        mono:  ["JetBrains Mono", "ui-monospace", "SF Mono", "monospace"],
      },
      colors: {
        // brand → avoce navy (backward-compat remap so existing class names pick up new palette)
        brand: {
          50:  "#EDE8DC",   // avoce-paper-deep
          100: "#F4F1EA",   // avoce-cream
          200: "#E0C98A",   // avoce-gold-soft
          400: "#C9A961",   // avoce-gold
          500: "#9CA0B3",   // avoce-mute-soft
          600: "#6B7186",   // avoce-mute
          700: "#3B5278",   // avoce-navy-soft
          800: "#3B5278",   // avoce-navy-soft
          900: "#0B2545",   // avoce-navy  ← sidebar, primary buttons
          950: "#061732",   // avoce-navy-deep
        },
        avoce: {
          navy:        "#0B2545",
          "navy-deep": "#061732",
          "navy-soft": "#3B5278",
          gold:        "#C9A961",
          "gold-soft": "#E0C98A",
          cream:       "#F4F1EA",
          paper:       "#FBF8F0",
          "paper-deep":"#EDE8DC",
          ink:         "#0A0A0A",
          mute:        "#6B7186",
          "mute-soft": "#9CA0B3",
          hair:        "#D9D3C2",
          "hair-soft": "#E8E2D3",
          success:     "#2F6B4F",
          warn:        "#B26B1F",
          danger:      "#9B2C2C",
          info:        "#3B5278",
        },
      },
      borderRadius: {
        // Avoce: sem border-radius — tudo ângulo reto
        DEFAULT: "0",
        none:    "0",
        sm:      "0",
        md:      "0",
        lg:      "0",
        xl:      "0",
        "2xl":   "0",
        full:    "9999px", // manter apenas para avatars/badges circulares
      },
    },
  },
  plugins: [],
};
