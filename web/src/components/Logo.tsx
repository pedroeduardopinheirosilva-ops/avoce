/**
 * AVOCE — Marca
 * Símbolo: Coroa de 12 pontos (1 dourado no topo) — referência velada à
 * Coroa de 12 estrelas de Nossa Senhora das Graças.
 * Wordmark: "avoce" em Inter 500, letter-spacing -0.045em.
 *
 * Uso:
 *   <CoroaMark size={28} />
 *   <AvoceWord size={20} />
 *   <AvoceLockup scale={1} />
 *
 *   // Sobre fundo escuro:
 *   <AvoceLockup color="#F4F1EA" accent="#C9A961" />
 */

import * as React from 'react';

export const AVOCE_COLORS = {
  navy:  '#0B2545',
  gold:  '#C9A961',
  cream: '#F4F1EA',
} as const;

export interface CoroaMarkProps {
  size?: number;
  /** Cor dos 11 pontos neutros. Default: navy. */
  color?: string;
  /** Cor do ponto do topo (12h). Default: gold. */
  accent?: string;
}

/**
 * Símbolo da marca. 12 pontos circulares dispostos em coroa.
 * O ponto do topo (índice 0) é maior e dourado — único elemento de "graça".
 */
export function CoroaMark({
  size = 28,
  color = AVOCE_COLORS.navy,
  accent = AVOCE_COLORS.gold,
}: CoroaMarkProps) {
  const dots = Array.from({ length: 12 }, (_, i) => {
    const t = (i / 12) * Math.PI * 2 - Math.PI / 2; // começa no topo
    const r = 24;
    return {
      cx: 32 + Math.cos(t) * r,
      cy: 32 + Math.sin(t) * r,
      r:  i === 0 ? 3.2 : 2,
      fill: i === 0 ? accent : color,
    };
  });

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role="img"
      aria-label="Avoce"
      style={{ display: 'block', flexShrink: 0 }}
    >
      {dots.map((d, i) => (
        <circle key={i} cx={d.cx} cy={d.cy} r={d.r} fill={d.fill} />
      ))}
    </svg>
  );
}

export interface AvoceWordProps {
  size?: number;
  color?: string;
}

/**
 * Wordmark "avoce". Sempre minúsculo, Inter 500, tracking apertado.
 */
export function AvoceWord({
  size = 18,
  color = AVOCE_COLORS.navy,
}: AvoceWordProps) {
  return (
    <span
      style={{
        fontFamily: '"Inter", system-ui, sans-serif',
        fontSize: size,
        fontWeight: 500,
        letterSpacing: '-0.045em',
        color,
        lineHeight: 1,
      }}
    >
      avoce
    </span>
  );
}

export interface AvoceLockupProps {
  /** Escala global. 1 = símbolo 26px + wordmark 20px. */
  scale?: number;
  color?: string;
  accent?: string;
}

/**
 * Lockup horizontal: símbolo + wordmark, gap proporcional.
 * Use este componente em headers, sidebars, login.
 */
export function AvoceLockup({
  scale = 1,
  color = AVOCE_COLORS.navy,
  accent = AVOCE_COLORS.gold,
}: AvoceLockupProps) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 * scale }}>
      <CoroaMark size={26 * scale} color={color} accent={accent} />
      <AvoceWord size={20 * scale} color={color} />
    </div>
  );
}
