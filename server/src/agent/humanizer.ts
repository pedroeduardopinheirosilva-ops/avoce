/**
 * Humanization validator — rejects robotic patterns before sending
 */

const ROBOTIC_PATTERNS = [
  /\(Sim[/\s]?[Nn]ão\)/,
  /\(S[/\s]?N\)/,
  /[Dd]igite\s+\d+/,
  /assistente\s+virtual/i,
  /inteligência\s+artificial/i,
  /\bbot\b/i,
  /\brobô\b/i,
  /[Oo]peração\s+realizada/,
  /[Dd]ados\s+(salvos|registrados|processados)/i,
  /[Pp]rocessando/,
  /[Ss]alvando/,
  /[Rr]egistrando/,
  /\bIA\b/,
  /inteligência artificial/i,
];

export function isHumanized(text: string): boolean {
  for (const pattern of ROBOTIC_PATTERNS) {
    if (pattern.test(text)) return false;
  }
  return true;
}

export function detectRoboticPattern(text: string): string | null {
  for (const pattern of ROBOTIC_PATTERNS) {
    if (pattern.test(text)) return pattern.source;
  }
  return null;
}
