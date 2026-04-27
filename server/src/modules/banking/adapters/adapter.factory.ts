import type { BankProvider } from "@prisma/client";
import type { IBankAdapter }  from "./bank.adapter.js";
import { SicoobAdapter }      from "./sicoob.adapter.js";
import { BradescoAdapter }    from "./bradesco.adapter.js";
import { InterAdapter }       from "./inter.adapter.js";
import { BtgAdapter }         from "./btg.adapter.js";

const adapters: Partial<Record<BankProvider, IBankAdapter>> = {};

export class AdapterFactory {
  static getAdapter(provider: BankProvider): IBankAdapter {
    if (!adapters[provider]) {
      switch (provider) {
        case "SICOOB":   adapters[provider] = new SicoobAdapter();   break;
        case "BRADESCO": adapters[provider] = new BradescoAdapter(); break;
        case "INTER":    adapters[provider] = new InterAdapter();    break;
        case "BTG":      adapters[provider] = new BtgAdapter();      break;
        default:
          throw new Error(`No adapter for provider: ${provider}`);
      }
    }
    return adapters[provider]!;
  }
}
