# Three-way merge against a Base; Financial Field conflicts are never auto-resolved

Both Sides can edit the same Invoice between syncs, and the two systems' clocks and timestamps cannot be trusted to order edits. Each Side's current state is therefore compared field by field against the Base, the last state both Sides agreed on. A field changed on one Side propagates to the other. A field changed on both Sides to the same value converges silently. A Cosmetic Field changed on both Sides to different values resolves last-writer-wins. A Financial Field changed on both Sides to different values becomes a Conflict that pauses that Invoice's sync until a person picks a Side.

## Considered Options

- **Last-writer-wins on everything**: rejected because it silently discards a money edit on the losing Side, and cross-system timestamps are unreliable anyway.
- **Fixed field ownership per Side**: rejected because users really do edit lines in both systems, and ownership would silently revert legitimate edits.

## Consequences

A Base snapshot must be stored per Link and advanced only after a write to the other Side is confirmed. A paused Invoice still accepts Change Hints, but nothing is written until its Conflict is resolved.
