// Minimal vscode mock for unit tests (no actual extension host needed)
export const window = {
  showInformationMessage: jest.fn(),
  showErrorMessage: jest.fn(),
  createOutputChannel: jest.fn(() => ({
    appendLine: jest.fn(),
    show: jest.fn(),
    dispose: jest.fn(),
  })),
};

export const workspace = {
  getConfiguration: jest.fn(() => ({
    get: jest.fn((key: string, def: any) => def),
  })),
  onDidChangeConfiguration: jest.fn(() => ({ dispose: jest.fn() })),
};

export const commands = {
  registerCommand: jest.fn(() => ({ dispose: jest.fn() })),
  executeCommand: jest.fn(),
};

export const ExtensionContext = jest.fn();
export const Uri = { parse: jest.fn(), file: jest.fn() };
export const ViewColumn = { One: 1 };
export const EventEmitter = jest.fn(() => ({
  event: jest.fn(),
  fire: jest.fn(),
  dispose: jest.fn(),
}));
