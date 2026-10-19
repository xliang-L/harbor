function configuration() {
  const endpoint = process.env.MODEL_BASE_URL;
  const name = process.env.MODEL_NAME;
  if (!endpoint || !name)
    throw new Error("模型未配置：需要本项目明确授权的 MODEL_BASE_URL 和 MODEL_NAME");
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new Error("模型地址无效");
  }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash)
    throw new Error("模型地址无效");
  if (u.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))
    throw new Error("远程模型端点必须使用 HTTPS");
  return { endpoint: endpoint.replace(/\/$/, ""), name };
}

async function request(path: string, body?: unknown, timeoutMs = 45000) {
  const { endpoint } = configuration();
  try {
    const response = await fetch(`${endpoint}/${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "Content-Type": "application/json",
        ...(process.env.MODEL_API_KEY
          ? { Authorization: `Bearer ${process.env.MODEL_API_KEY}` }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const hint =
        response.status === 401 || response.status === 403
          ? "授权失败，请在本机检查已有授权"
          : response.status === 429
            ? "额度或频率受限，不自动重试"
            : response.status === 404
              ? "接口不存在，请检查 BASE_URL 是否包含 /v1"
              : "服务失败，请检查本机服务状态";
      throw new Error(`模型 HTTP ${response.status}：${hint}`);
    }
    return await readJson(response);
  } catch (error) {
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))
      throw new Error("模型请求超时，未自动重试");
    if (error instanceof TypeError)
      throw new Error("模型连接失败，请检查本机服务、端口与网络；未自动重试");
    throw error;
  }
}

async function readJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("模型响应为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 1024 * 1024) {
      await reader.cancel();
      throw new Error("模型响应超过 1MB");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("模型响应不是有效 JSON");
  }
}

// Discovery only: a listed model does not prove upstream OAuth/quota or generation.
export async function checkModel(timeoutMs = 5000) {
  if (process.env.MODEL_ENABLED !== "true")
    return {
      status: "disabled",
      liveVerified: false,
      message: "模板模式：未发起模型连接",
    };
  const { name } = configuration();
  const result = await request("models", undefined, timeoutMs);
  if (!Array.isArray(result?.data) || result.data.some((item: any) => typeof item?.id !== "string"))
    throw new Error("模型列表格式不正确");
  const listed = result.data.some((item: { id: string }) => item.id === name);
  return {
    status: listed ? "reachable" : "model-not-found",
    liveVerified: false,
    message: listed
      ? "服务可达且模型已列出；尚未验证生成、上游授权或额度"
      : "服务可达，但未列出所选模型",
  };
}

export async function model(instruction: string, data: unknown) {
  const { name } = configuration();
  const result = await request("chat/completions", {
    model: name,
    stream: false,
    messages: [
      { role: "system", content: instruction },
      { role: "user", content: JSON.stringify(data) },
    ],
  });
  try {
    return JSON.parse(result.choices[0].message.content.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new Error("模型返回格式不正确，请重试");
  }
}
