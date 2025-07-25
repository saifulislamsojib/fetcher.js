import type {
  BaseMethodOptions,
  Configs,
  FetcherError,
  FetcherOptions,
  FetcherParams,
  FetcherResponse,
  FinalError,
  JsonAble,
  MethodOptions,
  OptionExtractor,
  RequestBody,
  ResponseBody,
} from './types';

class Fetcher {
  #configs: Configs = {};
  readonly #baseUrl: string;
  readonly #timeout: number;

  #configsExtractor: OptionExtractor = (configs) => configs;
  #finalError: FinalError = (err) => err;

  constructor({ baseUrl = '', timeout = 0 }: FetcherOptions = {}) {
    if (typeof fetch === 'undefined') {
      throw new Error(
        'The Fetch Web API is not supported in this environment, please use in a browser environment or Node.js version >= 18',
      );
    }
    this.#baseUrl = baseUrl;
    this.#timeout = timeout;
  }

  extractConfigs(optionExtractor: OptionExtractor) {
    this.#configsExtractor = optionExtractor;
  }

  setFinalError(finalError: FinalError) {
    this.#finalError = finalError;
  }

  setDefaultConfigs(configs: Configs) {
    this.#configs = configs;
  }

  #isJson({ headers }: Response) {
    return headers.get('content-type')?.includes('application/json');
  }

  async #fetcher<TResData extends ResponseBody>(
    url: string | URL,
    options: MethodOptions & {
      method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
    },
    body?: RequestBody,
  ) {
    const timeout = options.timeout ?? this.#timeout;
    const params = options.params;
    const responseType = options.responseType || 'json';
    delete options.responseType;

    if (params) {
      const search = Fetcher.convertParams(params);
      if (url instanceof URL) {
        url.search += (url.search ? '&' : '?') + search;
      } else {
        url += (url.includes('?') ? '&' : '?') + search;
      }
      delete options.params;
    }

    if (timeout) {
      delete options.timeout;
      const timeoutSignal = AbortSignal.timeout(timeout);
      if (options.signal) {
        options.signal = AbortSignal.any([options.signal, timeoutSignal]);
      } else options.signal = timeoutSignal;
    }
    const finalOptions: RequestInit = { ...this.#configsExtractor(this.#configs, url), ...options };

    if (body instanceof FormData) {
      if (finalOptions.headers) {
        Fetcher.getHeaders(finalOptions).delete('Content-Type');
      }
      finalOptions.body = body;
    } else if (body !== undefined) {
      if (!finalOptions.headers) {
        finalOptions.headers = { 'Content-Type': 'application/json' };
      } else {
        Fetcher.getHeaders(finalOptions).set('Content-Type', 'application/json');
      }
      finalOptions.body = JSON.stringify(body);
    }
    const response = await fetch(
      url instanceof URL ? url : url.startsWith('http') ? url : `${this.#baseUrl}${url}`,
      finalOptions,
    ).catch(async (err: Error) => {
      const isTimeout = err.name === 'TimeoutError' || err.message === 'TimeoutError';
      const error = new Error(
        isTimeout ? 'Request timed out' : err.message || 'Failed to fetch',
      ) as FetcherError;
      error.status = isTimeout ? 408 : 500;
      error.ok = false;
      error.name = isTimeout ? 'TimeoutError' : err.name || 'NetworkError';
      throw await this.#finalError(error, url);
    });

    const { ok, status, statusText } = response;
    if (!ok) {
      const error = new Error(
        `Request failed with status code ${status} -- ${statusText}`,
      ) as FetcherError;
      error.name = statusText;
      error.status = status;
      error.ok = false;
      if (this.#isJson(response)) {
        error.data = (await response.json()) as JsonAble;
      }
      throw await this.#finalError(error, url);
    }

    let data: TResData | undefined;
    if (
      options.method !== 'HEAD' &&
      options.method !== 'OPTIONS' &&
      (responseType !== 'json' || this.#isJson(response))
    ) {
      if (responseType === 'stream') {
        data = response.body as TResData;
      } else if (response[responseType]) {
        data = (await response[responseType]()) as TResData;
      }
    }
    const responseObj: FetcherResponse<TResData> = {
      ok,
      status,
      statusText,
      type: response.type,
      headers: response.headers,
      redirected: response.redirected,
      bodyUsed: response.bodyUsed,
      url: response.url,
      data: (data || null) as TResData,
    };
    return responseObj;
  }

  get<T extends ResponseBody = JsonAble>(url: string | URL, options: MethodOptions = {}) {
    return this.#fetcher<T>(url, { ...options, method: 'GET' });
  }

  post<T extends ResponseBody = JsonAble>(
    url: string | URL,
    body: RequestBody,
    options: MethodOptions = {},
  ) {
    return this.#fetcher<T>(url, { ...options, method: 'POST' }, body);
  }

  patch<T extends ResponseBody = JsonAble>(
    url: string | URL,
    body: RequestBody,
    options: MethodOptions = {},
  ) {
    return this.#fetcher<T>(url, { ...options, method: 'PATCH' }, body);
  }

  put<T extends ResponseBody = JsonAble>(
    url: string | URL,
    body: RequestBody,
    options: MethodOptions = {},
  ) {
    return this.#fetcher<T>(url, { ...options, method: 'PUT' }, body);
  }

  delete<T extends ResponseBody = JsonAble>(url: string | URL, options: MethodOptions = {}) {
    return this.#fetcher<T>(url, { ...options, method: 'DELETE' });
  }

  head(url: string | URL, options: BaseMethodOptions = {}) {
    return this.#fetcher<null>(url, { ...options, method: 'HEAD' });
  }

  options(url: string | URL, options: BaseMethodOptions = {}) {
    return this.#fetcher<null>(url, { ...options, method: 'OPTIONS' });
  }

  static convertParams = (params: FetcherParams) => {
    const paramsArr = Object.keys(params);
    if (!paramsArr.length) return '';
    const searchParams = new URLSearchParams();
    paramsArr.forEach((key) => {
      const value = params[key];
      if (value === undefined || value === null || value === '') return;
      if (typeof value === 'string') {
        searchParams.append(key, value);
      } else if (Array.isArray(value)) {
        value.forEach((v) => {
          if (v === undefined || v === null || v === '') return;
          if (typeof v === 'string') {
            searchParams.append(key, v);
          } else {
            searchParams.append(key, String(v));
          }
        });
      } else {
        searchParams.append(key, String(value));
      }
    });
    return searchParams.toString();
  };

  static getHeaders = (init: RequestInit): Headers => {
    if (init.headers instanceof Headers) return init.headers;
    init.headers = new Headers(init.headers);
    return init.headers;
  };

  static createFetcher = (options?: FetcherOptions) => new Fetcher(options) as Readonly<Fetcher>;
}

type TFetcher = InstanceType<typeof Fetcher>;

export type { TFetcher as Fetcher };
export const { createFetcher, convertParams } = Fetcher;
