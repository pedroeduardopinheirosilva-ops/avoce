import { z }                    from "zod";
import { router, authProc }     from "./trpc.js";
import { TRPCError }            from "@trpc/server";
import { spawn, execFile }      from "node:child_process";
import { promises as fs }       from "node:fs";
import path                     from "node:path";
import { promisify }            from "node:util";

const execFileP = promisify(execFile);

/** O PM2 herda um PATH enxuto; chamar utilitário de sistema pelo caminho absoluto. */
const BIN = {
  systemctl: "/usr/bin/systemctl",
  flock: "/usr/bin/flock",
  tail: "/usr/bin/tail",
  setsid: "/usr/bin/setsid",
};

/**
 * Motores de coleta: robôs que rodam fora do Avoce (systemd, no mesmo servidor)
 * e despejam leads nos funis do CRM. A tela do funil precisa de duas coisas —
 * disparar sob demanda e ver em que pé está —, e é só isso que este router faz.
 *
 * O robô é o dono do estado: ele escreve `estado_motor.json` ao começar e ao
 * terminar, e se protege com flock. Aqui a gente só lê esse arquivo e dispara o
 * script; nada de status inventado do lado do Node, que perderia o que foi
 * disparado pelo timer.
 */

type Motor = {
  id: string;
  nome: string;
  descricao: string;
  dir: string;
  script: string;
  estado: string;
  timer?: string;
  /** funis do CRM que este motor alimenta — usado pela tela para se oferecer */
  pipelines: string[];
  /**
   * Disparo de e-mail dos leads novos que o motor trouxe (pelo PSA-MT). O script
   * aceita `previa` (JSON no stdout, não envia) e `enviar <limite>`; escreve o
   * próprio estado e se protege com o próprio lock, como o motor.
   */
  emails?: { script: string; estado: string; lock: string; pipelines: string[] };
};

const MOTORES: Record<string, Motor> = {
  "consef-sefaz-ba": {
    id: "consef-sefaz-ba",
    nome: "Autos de infração SEFAZ-BA",
    descricao:
      "Varre os autos de ICMS lavrados pela SEFAZ-BA, descobre o autuado, " +
      "o cadastro da empresa e o contador responsável, e grava os leads nos funis.",
    dir: process.env.CONSEF_DIR ?? "/opt/consef-autos",
    script: "rodar_semanal.sh",
    estado: "estado_motor.json",
    timer: "consef-semanal.timer",
    pipelines: ["pipeline_defesa_icms", "pipeline_contadores"],
    emails: {
      script: "emails_novos.sh",
      estado: "estado_emails.json",
      lock: ".emails.lock",
      pipelines: ["pipeline_defesa_icms"],
    },
  },
  "epat-sefaz-sp": {
    id: "epat-sefaz-sp",
    nome: "Autos de infração SEFAZ-SP",
    descricao:
      "Descobre os AIIMs novos no extrato público do ePAT da SEFAZ-SP, resolve CNPJ e " +
      "e-mail do autuado na base aberta da Receita Federal e grava os leads no funil.",
    dir: process.env.EPAT_SP_DIR ?? "/opt/epat-sp-autos",
    script: "rodar.sh",
    estado: "estado_motor.json",
    timer: "epat-sp.timer",
    pipelines: ["pipeline_defesa_icms_sp"],
    emails: {
      script: "emails_sp.sh",
      estado: "estado_emails.json",
      lock: ".emails.lock",
      pipelines: ["pipeline_defesa_icms_sp"],
    },
  },
};

function pegar(id: string): Motor {
  const m = MOTORES[id];
  if (!m) throw new TRPCError({ code: "NOT_FOUND", message: `motor desconhecido: ${id}` });
  return m;
}

function emailsDe(m: Motor) {
  if (!m.emails) throw new TRPCError({ code: "NOT_FOUND", message: `motor sem disparo de e-mail: ${m.id}` });
  return m.emails;
}

async function lerEstado(m: Motor, arquivo = m.estado) {
  try {
    const raw = await fs.readFile(path.join(m.dir, arquivo), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Uma execução só é "rodando" se o lock ainda estiver preso por algum processo. */
async function rodando(m: Motor, lock = ".motor.lock"): Promise<boolean> {
  try {
    const { stdout } = await execFileP(BIN.flock, ["-n", path.join(m.dir, lock), "-c", "true"]);
    void stdout;
    return false;            // conseguiu o lock → ninguém rodando
  } catch {
    return true;             // lock preso
  }
}

/** Próxima execução agendada, se houver timer do systemd. Silencioso se não der. */
async function proxima(m: Motor): Promise<string | null> {
  if (!m.timer) return null;
  try {
    const { stdout } = await execFileP(BIN.systemctl, [
      "show", m.timer, "-p", "NextElapseUSecRealtime", "--value",
    ]);
    // o systemd devolve texto legível, não microssegundos:
    // "Mon 2026-09-14 06:43:35 -03" → ISO
    const v = stdout.trim();
    if (!v || v === "0" || v === "n/a") return null;
    // NÃO chamar de `m`: sombrearia o parâmetro `m` (Motor) usado acima no mesmo
    // bloco e derrubaria a função por TDZ — o catch engoliria e viraria null.
    const parte = v.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s*([+-]\d{2})(\d{2})?/);
    if (!parte) return null;
    const d = new Date(`${parte[1]}T${parte[2]}${parte[3]}:${parte[4] ?? "00"}`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

async function tail(arquivo: string, linhas: number): Promise<string> {
  try {
    const { stdout } = await execFileP(BIN.tail, ["-n", String(linhas), arquivo]);
    return stdout;
  } catch {
    return "";
  }
}

export const motoresRouter = router({
  /** Motores que alimentam um funil — a tela usa para decidir se mostra a barra. */
  doPipeline: authProc
    .input(z.object({ pipelineId: z.string() }))
    .query(({ input }) =>
      Object.values(MOTORES)
        .filter((m) => m.pipelines.includes(input.pipelineId))
        .map((m) => ({
          id: m.id, nome: m.nome, descricao: m.descricao,
          emails: !!m.emails?.pipelines.includes(input.pipelineId),
        })),
    ),

  status: authProc
    .input(z.object({ motorId: z.string() }))
    .query(async ({ input }) => {
      const m = pegar(input.motorId);
      const [estado, emExecucao, agendada] = await Promise.all([
        lerEstado(m), rodando(m), proxima(m),
      ]);
      const log = estado?.log ? path.join(m.dir, String(estado.log)) : null;
      return {
        motorId: m.id,
        nome: m.nome,
        descricao: m.descricao,
        rodando: emExecucao,
        proximaExecucao: agendada,
        status: (estado?.status as string) ?? null,
        gatilho: (estado?.gatilho as string) ?? null,
        inicio: (estado?.inicio as string) ?? null,
        fim: (estado?.fim as string) ?? null,
        duracaoSeg: (estado?.duracao_seg as number) ?? null,
        resultado: (estado?.resultado as string) ?? null,
        resumo: (estado?.resumo as string) ?? null,
        log: log ? await tail(log, emExecucao ? 40 : 25) : "",
      };
    }),

  log: authProc
    .input(z.object({ motorId: z.string(), linhas: z.number().min(10).max(500).default(120) }))
    .query(async ({ input }) => {
      const m = pegar(input.motorId);
      const estado = await lerEstado(m);
      if (!estado?.log) return "";
      return tail(path.join(m.dir, String(estado.log)), input.linhas);
    }),

  disparar: authProc
    .input(z.object({ motorId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const m = pegar(input.motorId);
      if (await rodando(m)) {
        throw new TRPCError({ code: "CONFLICT", message: "o motor já está rodando" });
      }
      const alvo = path.join(m.dir, m.script);
      try {
        await fs.access(alvo);
      } catch {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `script não encontrado: ${alvo}` });
      }
      // setsid + detached: o robô leva minutos e precisa sobreviver ao fim da
      // requisição E a um `pm2 restart avoce` — sem isso o PM2 derruba a árvore.
      const filho = spawn(BIN.setsid, ["bash", alvo], {
        cwd: m.dir,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, MOTOR_GATILHO: `manual:${ctx.userId ?? "?"}` },
      });
      filho.unref();
      return { ok: true, iniciadoEm: new Date().toISOString() };
    }),

  /** Estado do último disparo de e-mails dos autos novos. */
  emailsStatus: authProc
    .input(z.object({ motorId: z.string() }))
    .query(async ({ input }) => {
      const m = pegar(input.motorId);
      const e = emailsDe(m);
      const [estado, emExecucao] = await Promise.all([lerEstado(m, e.estado), rodando(m, e.lock)]);
      const log = estado?.log ? path.join(m.dir, String(estado.log)) : null;
      return {
        rodando: emExecucao,
        status: (estado?.status as string) ?? null,
        inicio: (estado?.inicio as string) ?? null,
        fim: (estado?.fim as string) ?? null,
        resultado: (estado?.resultado as string) ?? null,
        log: log ? await tail(log, 30) : "",
      };
    }),

  /** O que sairia agora: só os autos que ainda não foram comunicados. Não envia nada. */
  emailsPrevia: authProc
    .input(z.object({ motorId: z.string() }))
    .query(async ({ input }) => {
      const m = pegar(input.motorId);
      const e = emailsDe(m);
      if (await rodando(m, e.lock)) {
        throw new TRPCError({ code: "CONFLICT", message: "já há um disparo de e-mails em andamento" });
      }
      try {
        const { stdout } = await execFileP("/usr/bin/bash", [path.join(m.dir, e.script), "previa"], {
          cwd: m.dir, timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
        });
        return JSON.parse(stdout) as {
          emails: { para: string; via: string; empresas: string[]; deal_ids: string[];
                    autos: string[]; total: number; assunto: string }[];
          fora: { razao: string; deal_id: string; autos: string[]; motivo: string }[];
          n_autos: number;
          limite: number;
        };
      } catch (err: any) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `prévia falhou: ${String(err?.stdout || err?.stderr || err?.message).slice(0, 300)}`,
        });
      }
    }),

  emailsDisparar: authProc
    .input(z.object({ motorId: z.string(), limite: z.number().int().min(1).max(200).default(50) }))
    .mutation(async ({ input, ctx }) => {
      const m = pegar(input.motorId);
      const e = emailsDe(m);
      if (await rodando(m, e.lock)) {
        throw new TRPCError({ code: "CONFLICT", message: "já há um disparo de e-mails em andamento" });
      }
      if (await rodando(m)) {
        throw new TRPCError({ code: "CONFLICT", message: "espere a coleta de autos terminar" });
      }
      // leva ~1 min por e-mail (intervalo anti-bloqueio do HotelDaWeb): setsid, como o motor
      const filho = spawn(BIN.setsid, ["bash", path.join(m.dir, e.script), "enviar", String(input.limite)], {
        cwd: m.dir,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, MOTOR_GATILHO: `manual:${ctx.userId ?? "?"}` },
      });
      filho.unref();
      return { ok: true, iniciadoEm: new Date().toISOString() };
    }),
});
