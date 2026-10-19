import type { State } from "../../server/types";
export type Data = State & { mode: string };
export type Act = (path: string, body: unknown) => Promise<any>;
