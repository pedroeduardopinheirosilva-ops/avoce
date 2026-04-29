import { describe, it, expect } from "vitest";
import { extractText, type EvolutionWebhookMessage } from "./webhook-parser.js";

function msg(overrides: Partial<EvolutionWebhookMessage>): EvolutionWebhookMessage {
  return {
    key: { id: "abc", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false },
    ...overrides,
  };
}

describe("extractText", () => {
  it("returns conversation text", () => {
    expect(extractText(msg({ message: { conversation: "Olá" } }))).toBe("Olá");
  });

  it("returns extendedTextMessage text", () => {
    expect(extractText(msg({ message: { extendedTextMessage: { text: "Oi tudo bem" } } }))).toBe("Oi tudo bem");
  });

  it("returns image caption", () => {
    expect(extractText(msg({ message: { imageMessage: { caption: "Minha CNH" } } }))).toBe("Minha CNH");
  });

  it("returns null for audio message (no text content)", () => {
    expect(extractText(msg({ message: { audioMessage: { url: "https://example.com/audio" } } }))).toBeNull();
  });

  it("returns null for document without caption", () => {
    expect(extractText(msg({ message: { documentMessage: { url: "https://example.com/doc.pdf" } } }))).toBeNull();
  });

  it("returns null when message is absent", () => {
    expect(extractText(msg({ message: undefined }))).toBeNull();
  });

  it("prefers conversation over imageMessage caption when both present", () => {
    expect(extractText(msg({ message: { conversation: "Texto", imageMessage: { caption: "Legenda" } } }))).toBe("Texto");
  });
});
