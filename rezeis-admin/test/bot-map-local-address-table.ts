/**
 * What an address on this machine is — the table reiwa's test pins its own
 * `isLocalAddress` with (P1, `main-keyboard.ts`), shared by the specs that pin
 * the panel's: the route model's two copies (`bot-map-route-parity.spec.ts`)
 * and the composer's screen buttons (`bot-map-composer.service.spec.ts`).
 *
 * Its host, exactly `localhost` or `127.0.0.1` — never a mention of one in the
 * path or the query — and an address that does not parse is not one.
 */
export const LOCAL_ADDRESS_TABLE: ReadonlyArray<readonly [address: string, local: boolean]> = [
  ['http://localhost', true],
  ['http://localhost:3000/x', true],
  ['https://LOCALHOST/x', true],
  ['http://127.0.0.1:8080', true],
  ['https://localhost.example.com', false],
  ['https://example.com/?next=http://localhost/x', false],
  ['https://cabinet.example/r?next=http://127.0.0.1', false],
  ['not a url', false],
  ['https://example.com', false],
];
