import {moneyNetworkFor,type MoneyMode,type MoneyNetwork} from "../config/money-environment.js";

/**
 * Environment/network written to and filtered on money tables. Values come from a
 * closed set validated here, so repositories may inline them as SQL literals.
 */
export interface RowEnvironment {
 readonly mode:MoneyMode;
 readonly network:MoneyNetwork;
}

export function rowEnvironment(mode:MoneyMode):RowEnvironment {
 if(mode!=="test" && mode!=="live")
  throw Object.assign(new Error("MONEY_ENVIRONMENT_INVALID"),{code:"MONEY_ENVIRONMENT_INVALID"});
 return Object.freeze({mode,network:moneyNetworkFor(mode)});
}
