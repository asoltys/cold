import { writable } from 'svelte/store';
import { browser } from "$app/environment";

export const focus = (el: HTMLElement) =>
	browser && screen.width > 1280 && setTimeout(() => el.focus(), 1);

export const mnemonic = writable();
