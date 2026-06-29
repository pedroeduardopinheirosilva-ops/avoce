// Script one-shot: reenvia e-mails de cobrança do dia atual
// Uso: node resend-hoje.mjs
// Roda em /opt/avoce/server/
import { enviarEmailCobranca } from './dist/lib/email-cobranca.js';
import { prisma }              from './dist/db.js';

const hoje = new Date();
hoje.setUTCHours(0, 0, 0, 0);

const cobranças = await prisma.cobranca.findMany({
  where: { criadoEm: { gte: hoje } },
  orderBy: { criadoEm: 'asc' },
  select: { id: true, competencia: true, valor: true, criadoEm: true,
            contrato: { select: { tomador: { select: { nome: true } } } } },
});

console.log(`\n✉  Reenviando ${cobranças.length} cobranças de hoje para BCC...\n`);

let ok = 0, erros = 0;
for (const c of cobranças) {
  const tomador = c.contrato?.tomador?.nome ?? '?';
  process.stdout.write(`  [${++ok + erros}/${cobranças.length}] ${tomador} — ${c.competencia} ... `);
  try {
    await enviarEmailCobranca(c.id);
    console.log('OK');
    ok++;
  } catch (e) {
    console.log(`ERRO: ${e.message}`);
    erros++;
    ok--;
  }
}

console.log(`\nConcluído: ${ok} enviados, ${erros} erros\n`);
await prisma.$disconnect();
