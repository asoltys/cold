<script>
	import { goto } from '$app/navigation';
	import { onMount, tick } from 'svelte';
	import { mnemonic, focus } from '$lib';
	import { generateMnemonic } from '@scure/bip39';
	import { wordlist } from '@scure/bip39/wordlists/english';
	import Mnemonic from '$lib/Mnemonic.svelte';

	let password;

	let submitted;
	let bm;
	onMount(async () => {
		$mnemonic = await generateMnemonic(wordlist);
	});

	let submit = async () => {
		submitted = true;
		await tick();

		goto('/created');
	};
</script>

<Mnemonic mnemonic={$mnemonic} />

<form class="space-y-5 text-center" on:submit|preventDefault={submit}>
	<div>
		<input
			use:focus
			name="password"
			class="rounded-2xl bg-white p-4 text-2xl"
			placeholder="Passphrase"
			bind:value={password}
		/>
	</div>

	<button
		type="submit"
		class="mx-auto flex w-full justify-center gap-2 rounded-2xl border bg-white p-4 md:w-60"
	>
		<div class="my-auto">Submit</div>
	</button>
</form>
