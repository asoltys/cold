import { browser } from "$app/environment";
import { writable } from "svelte/store";

export const focus = (el: HTMLElement) =>
	browser && screen.width > 1280 && setTimeout(() => el.focus(), 1);

export const mnemonic = writable();
export const password = writable();
export const address = writable();
