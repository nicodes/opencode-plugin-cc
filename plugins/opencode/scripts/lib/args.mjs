export function splitRawArgumentString(input) {
  const values = [];
  let value = "";
  let quote = null;
  let escaped = false;

  for (const character of String(input ?? "")) {
    if (escaped) {
      value += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        value += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (value) {
        values.push(value);
        value = "";
      }
      continue;
    }
    value += character;
  }

  if (escaped) {
    value += "\\";
  }
  if (quote) {
    throw new Error("Unterminated quote in arguments.");
  }
  if (value) {
    values.push(value);
  }
  return values;
}

export function normalizeArgv(argv) {
  if (argv.length === 1) {
    return splitRawArgumentString(argv[0]);
  }
  return argv;
}

export function parseArgs(argv, options = {}) {
  const valueOptions = new Set(options.valueOptions ?? []);
  const booleanOptions = new Set(options.booleanOptions ?? []);
  const aliases = options.aliases ?? {};
  const parsed = {};
  const positionals = [];
  const input = normalizeArgv(argv);

  for (let index = 0; index < input.length; index += 1) {
    const token = input[index];
    if (token === "--") {
      positionals.push(...input.slice(index + 1));
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    const rawName = token.replace(/^-+/, "");
    const name = aliases[rawName] ?? rawName;
    if (booleanOptions.has(name)) {
      parsed[name] = true;
      continue;
    }
    if (valueOptions.has(name)) {
      const next = input[index + 1];
      if (next == null) {
        throw new Error(`Missing value for --${name}.`);
      }
      parsed[name] = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }

  return { options: parsed, positionals };
}
