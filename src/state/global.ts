import * as vscode from "vscode";
import * as constants from "../constants";
import { setContext } from "../utils";

// eslint-disable-next-line no-use-before-define
export let globalState: GlobalState;

export class GlobalState {
  state: vscode.Memento;

  constructor(context: vscode.ExtensionContext) {
    this.state = context.globalState;
  }

  get credentialsFile(): string | undefined {
    return this.state.get<string>("credentialsFile");
  }

  set credentialsFile(value: string | undefined) {
    this.state.update("credentialsFile", value);
    this.setIsLoggedInContext(this.isLoggedIn);
  }

  get isLoggedIn(): boolean {
    return this.credentialsFile !== undefined;
  }

  get cloudflaredUri(): vscode.Uri | undefined {
    return this.state.get<vscode.Uri>("cloudflaredUri");
  }

  set cloudflaredUri(value: vscode.Uri | undefined) {
    this.state.update("cloudflaredUri", value);
  }

  get recentLocalOrigins(): string[] {
    return this.state.get<string[]>("recentLocalOrigins", []);
  }

  addRecentLocalOrigin(origin: string, limit = 10): void {
    const value = origin.trim();

    if (!value) {
      return;
    }

    const recent = [
      value,
      ...this.recentLocalOrigins.filter(item => item !== value),
    ].slice(0, limit);

    this.state.update("recentLocalOrigins", recent);
  }

  setIsLoggedInContext(value: boolean): void {
    setContext(constants.Context.isLoggedIn, value);
  }

  static init(context: vscode.ExtensionContext): GlobalState {
    globalState = new GlobalState(context);
    return globalState;
  }
}
