# Ledger is synced through Account Mapping, not by writing journal entries

The brief asks to "sync general ledger entries and accounts". QBO already posts accounts receivable, income and deposit entries itself when an Invoice or Payment is created. Writing JournalEntries as well would double-count revenue. So we sync the ledger indirectly: an Account Mapping routes each internal revenue category to a QBO item/income account and each payment method to a deposit account. A read-only check then compares QBO's posted totals for synced Invoices against the Internal System's totals.

## Considered Options

- **Bidirectional JournalEntry/Account sync**: rejected because of the double posting, and because the chart of accounts belongs to the accountant, not to the Internal System.
