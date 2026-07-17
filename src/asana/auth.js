import { readFile as nodeReadFile, stat as nodeStat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

export async function loadToken({
  env = process.env,
  homeDir = homedir(),
  readFile = nodeReadFile,
  stat = nodeStat,
} = {}) {
  const environmentToken = env.ASANA_ACCESS_TOKEN?.trim();
  if (environmentToken) return { token: environmentToken, source: "environment" };

  const path = env.ASANA_TOKEN_FILE || join(homeDir, ".config", "workflows", "asana-token");
  let content;
  let metadata;
  try {
    [content, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new AuthError(`Asana authentication is not configured. Create ${path} with mode 600 or set ASANA_ACCESS_TOKEN.`);
    }
    throw new AuthError(`Unable to read the Asana token file at ${path}.`);
  }

  const token = String(content).trim();
  if (!token) throw new AuthError(`The Asana token file at ${path} is empty.`);

  const result = { token, source: path };
  if ((metadata.mode & 0o077) !== 0) {
    result.warning = `Token file permissions are too broad; run: chmod 600 ${path}`;
  }
  return result;
}
