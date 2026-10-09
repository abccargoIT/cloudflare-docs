import type {
	MediaUrlResponse,
	SendMessageResponse,
	TemplateSendRequest,
} from "./types.ts";

export class WhatsAppApiError extends Error {
	readonly httpStatus: number;
	readonly metaCode: number | undefined;
	readonly retryable: boolean;

	constructor(
		message: string,
		httpStatus: number,
		metaCode?: number,
		retryable = false,
	) {
		super(message);
		this.name = "WhatsAppApiError";
		this.httpStatus = httpStatus;
		this.metaCode = metaCode;
		this.retryable = retryable;
	}
}

export interface WhatsAppClientOptions {
	accessToken: string;
	graphApiVersion: string;
	/** Injected for tests. Defaults to the global fetch. */
	fetchImpl?: typeof fetch;
}

/**
 * Thin client over the Meta Graph API endpoints used by this platform.
 * The access token is never logged and never included in thrown errors.
 */
export class WhatsAppClient {
	private readonly token: string;
	private readonly base: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: WhatsAppClientOptions) {
		this.token = options.accessToken;
		this.base = `https://graph.facebook.com/${options.graphApiVersion}`;
		// Wrapped rather than stored bare. Kept as a property and called as
		// `this.fetchImpl(...)`, the global fetch would receive the client as
		// its `this`, which the Workers runtime refuses with "Illegal
		// invocation" — every send would fail before reaching Meta.
		this.fetchImpl =
			options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
	}

	sendText(
		phoneNumberId: string,
		to: string,
		body: string,
		options: { previewUrl?: boolean; replyToMessageId?: string } = {},
	): Promise<SendMessageResponse> {
		return this.postMessage(phoneNumberId, {
			to,
			type: "text",
			text: { body, preview_url: options.previewUrl ?? false },
			...(options.replyToMessageId
				? { context: { message_id: options.replyToMessageId } }
				: {}),
		});
	}

	sendTemplate(
		phoneNumberId: string,
		to: string,
		template: TemplateSendRequest,
	): Promise<SendMessageResponse> {
		return this.postMessage(phoneNumberId, {
			to,
			type: "template",
			template: {
				name: template.name,
				language: { code: template.languageCode },
				...(template.components ? { components: template.components } : {}),
			},
		});
	}

	sendInteractiveButtons(
		phoneNumberId: string,
		to: string,
		bodyText: string,
		buttons: { id: string; title: string }[],
	): Promise<SendMessageResponse> {
		return this.postMessage(phoneNumberId, {
			to,
			type: "interactive",
			interactive: {
				type: "button",
				body: { text: bodyText },
				action: {
					buttons: buttons.slice(0, 3).map((b) => ({
						type: "reply",
						reply: { id: b.id, title: b.title.slice(0, 20) },
					})),
				},
			},
		});
	}

	/**
	 * Uploads a file to Meta and returns the media id to send it with.
	 *
	 * Uploading rather than sending a link, because a link has to be publicly
	 * reachable — which would mean exposing a customer's commercial invoice on
	 * a URL anybody could guess. The id is private to the WABA and expires,
	 * which is why the platform also keeps its own copy in R2.
	 *
	 * This is a multipart form post, not JSON, so it does not go through
	 * `request`.
	 */
	async uploadMedia(input: {
		phoneNumberId: string;
		bytes: ArrayBuffer;
		mimeType: string;
		filename: string;
	}): Promise<{ id: string }> {
		const form = new FormData();
		form.append("messaging_product", "whatsapp");
		form.append("type", input.mimeType);
		form.append(
			"file",
			new Blob([input.bytes], { type: input.mimeType }),
			input.filename,
		);

		const response = await this.fetchImpl(
			`${this.base}/${input.phoneNumberId}/media`,
			{
				method: "POST",
				// No Content-Type: the boundary has to be set by FormData.
				headers: { Authorization: `Bearer ${this.token}` },
				body: form,
			},
		);

		const text = await response.text();
		let parsed: unknown = undefined;
		try {
			parsed = text ? JSON.parse(text) : undefined;
		} catch {
			parsed = undefined;
		}

		if (!response.ok) {
			const error = (parsed as { error?: { message?: string; code?: number } })
				?.error;
			throw new WhatsAppApiError(
				`Graph API media upload failed: HTTP ${response.status}${
					error?.message ? ` - ${error.message}` : ""
				}`,
				response.status,
				error?.code,
				response.status >= 500 || response.status === 429,
			);
		}

		const id = (parsed as { id?: string })?.id;
		if (!id) {
			throw new WhatsAppApiError(
				"Graph API media upload returned no id",
				response.status,
				undefined,
				false,
			);
		}
		return { id };
	}

	/**
	 * Sends an already-uploaded attachment.
	 *
	 * `caption` is accepted by image, document and video only; Meta ignores or
	 * rejects it on audio and stickers, so the caller's caption is dropped for
	 * those rather than sent and silently lost.
	 */
	sendMedia(input: {
		phoneNumberId: string;
		to: string;
		kind: "image" | "document" | "audio" | "video" | "sticker";
		mediaId: string;
		caption?: string;
		filename?: string;
	}): Promise<SendMessageResponse> {
		const captionable =
			input.kind === "image" ||
			input.kind === "document" ||
			input.kind === "video";
		const body: Record<string, unknown> = { id: input.mediaId };
		if (captionable && input.caption) body["caption"] = input.caption;
		// The filename is what the customer sees in the chat, and it only
		// applies to a document.
		if (input.kind === "document" && input.filename) {
			body["filename"] = input.filename;
		}

		return this.postMessage(input.phoneNumberId, {
			to: input.to,
			type: input.kind,
			[input.kind]: body,
		});
	}

	sendLocation(input: {
		phoneNumberId: string;
		to: string;
		latitude: number;
		longitude: number;
		name?: string;
		address?: string;
	}): Promise<SendMessageResponse> {
		return this.postMessage(input.phoneNumberId, {
			to: input.to,
			type: "location",
			location: {
				latitude: input.latitude,
				longitude: input.longitude,
				...(input.name ? { name: input.name } : {}),
				...(input.address ? { address: input.address } : {}),
			},
		});
	}

	async markAsRead(phoneNumberId: string, messageId: string): Promise<void> {
		await this.request(`/${phoneNumberId}/messages`, {
			method: "POST",
			body: {
				messaging_product: "whatsapp",
				status: "read",
				message_id: messageId,
			},
		});
	}

	getMediaUrl(mediaId: string): Promise<MediaUrlResponse> {
		return this.request<MediaUrlResponse>(`/${mediaId}`, { method: "GET" });
	}

	/**
	 * Media URLs returned by Meta are short-lived and require the bearer
	 * token, so the download must happen server-side promptly after receipt.
	 */
	async downloadMedia(
		mediaId: string,
	): Promise<{ bytes: ArrayBuffer; mimeType: string; sha256: string }> {
		const meta = await this.getMediaUrl(mediaId);
		const response = await this.fetchImpl(meta.url, {
			headers: { Authorization: `Bearer ${this.token}` },
		});
		if (!response.ok) {
			throw new WhatsAppApiError(
				`Media download failed with HTTP ${response.status}`,
				response.status,
				undefined,
				response.status >= 500 || response.status === 429,
			);
		}
		return {
			bytes: await response.arrayBuffer(),
			mimeType: meta.mime_type,
			sha256: meta.sha256,
		};
	}

	private postMessage(
		phoneNumberId: string,
		payload: Record<string, unknown>,
	): Promise<SendMessageResponse> {
		return this.request<SendMessageResponse>(`/${phoneNumberId}/messages`, {
			method: "POST",
			body: {
				messaging_product: "whatsapp",
				recipient_type: "individual",
				...payload,
			},
		});
	}

	private async request<T>(
		path: string,
		init: { method: "GET" | "POST"; body?: unknown },
	): Promise<T> {
		const response = await this.fetchImpl(`${this.base}${path}`, {
			method: init.method,
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": "application/json",
			},
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		});

		const text = await response.text();
		let parsed: unknown = undefined;
		try {
			parsed = text ? JSON.parse(text) : undefined;
		} catch {
			parsed = undefined;
		}

		if (!response.ok) {
			const error = (parsed as { error?: { message?: string; code?: number } })
				?.error;
			throw new WhatsAppApiError(
				`Graph API ${init.method} ${path} failed: HTTP ${response.status}${
					error?.message ? ` - ${error.message}` : ""
				}`,
				response.status,
				error?.code,
				response.status >= 500 || response.status === 429,
			);
		}
		return parsed as T;
	}
}
