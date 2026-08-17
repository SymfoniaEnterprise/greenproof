/** Raporty wychodzące do człowieka - jedyny kierunek komunikacji biblioteki. */

export type HumanReportKind =
  | 'roster' // wynik filtra: lista wybranych case'ów + timeouty + warningi
  | 'draft_delivered'
  | 'case_blocked'
  | 'app_defect_suspected' // deklaracja agenta „kontrakt API blokuje flow" - do priorytetowego przeglądu
  | 'knowledge_proposals' // propozycje ui-traps / churn-prone do zatwierdzenia
  | 'released'
  | 'run_failed';

export interface HumanReport {
  kind: HumanReportKind;
  title: string;
  /** Render domyślny (GitHub issue itd.). */
  markdown: string;
  /**
   * Dane strukturalne raportu - customowa platforma może renderować po
   * swojemu zamiast używać markdownu.
   */
  data: unknown;
  /**
   * Deterministyczny identyfikator raportu (np. "<runId>:<caseId>:draft_delivered")
   * - pozwala adapterowi na idempotentny update zamiast duplikatu.
   */
  reportId: string;
}
