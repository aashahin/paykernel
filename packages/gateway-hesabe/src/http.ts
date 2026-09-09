import {
  AuthenticationError,
  GatewayApiError,
  InvalidRequestError,
  NetworkError,
  RateLimitError,
  ResourceNotFoundError,
  parseRetryAfterSeconds,
} from "@paykernel/core";

export function mapHesabeHttpFailure(input: {
  status: number;
  headers?: Headers;
  postSubmit: boolean;
}): Error {
  const { status, headers, postSubmit } = input;
  const tag = postSubmit ? ({ afterProviderSubmit: true } as const) : undefined;
  const raw = { status };
  if (status === 429) {
    const retryAfter = parseRetryAfterSeconds(headers);
    return retryAfter !== undefined
      ? new RateLimitError("hesabe", retryAfter)
      : new RateLimitError("hesabe");
  }
  if (status >= 500) {
    return new NetworkError(`Hesabe API error (${status})`, raw, tag);
  }
  if (status === 401 || status === 403) {
    return new AuthenticationError(`Hesabe API error (${status})`, raw);
  }
  if (status === 404) {
    return new ResourceNotFoundError(`Hesabe API error (${status})`, raw);
  }
  if (status >= 400 && status < 500) {
    return new InvalidRequestError(`Hesabe API error (${status})`, [raw]);
  }
  return new GatewayApiError(`Hesabe API error (${status})`, "hesabe", raw);
}

export function isHesabeRetryableError(error: unknown): boolean {
  return error instanceof NetworkError || error instanceof RateLimitError;
}
