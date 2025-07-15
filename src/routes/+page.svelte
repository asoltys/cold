<script>
	import { hex } from '@scure/base';
	import { HDKey } from '@scure/bip32';
	import * as btc from '@scure/btc-signer';
	import { goto } from '$app/navigation';
	import { onMount, tick } from 'svelte';
	import { focus } from '$lib';
	import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
	import { wordlist } from '@scure/bip39/wordlists/english';

	import { getAddress, p2wpkh } from '@scure/btc-signer/payment';

	let NET = 'bitcoin';
	const versions = {
		bitcoin: {
			private: 0x0488ade4,
			public: 0x0488b21e
		},
		regtest: {
			private: 0x04358394,
			public: 0x043587cf
		}
	}[NET];

	const network = {
		bitcoin: {
			bech32: 'bc',
			pubKeyHash: 0x00,
			scriptHash: 0x05,
			wif: 0x80
		},
		regtest: {
			bech32: 'bcrt',
			pubKeyHash: 0x6f,
			scriptHash: 0xc4,
			wif: 0xef
		}
	}[NET];

	let fees, rate;
	let utxos = [];

	let api = 'https://mempool.space/api';
	let amt = $state();
	// let destination = $state('bc1qqz6nlwxwmfqw0v864p5sggqst2xf0mevtyc579');
	// let password = $state('123');
	// let mnemonic = $state(
	// 	'lizard armor follow dinner quarter talent truly among column rebuild arrest mix'
	// );
	// let withdrawing = $state(true);
	let destination = $state();
	let password = $state();
	let mnemonic = $state();
	let withdrawing = $state();

	let balance = $state();
	let pending = $state();

	let loading = $state();

	let generate = async () => {
		mnemonic = await generateMnemonic(wordlist);
	};

	onMount(async () => {
		// setTimeout(checkBalance, 1000);

		if (NET === 'regtest') {
			fees = { fastestFee: 281, halfHourFee: 271, hourFee: 256, economyFee: 44, minimumFee: 22 };
		} else {
			fees = await fetch(`${api}/v1/fees/recommended`).then((r) => r.json());
		}

		rate = fees['halfHourFee'];
	});

	let getHex = async (txid) => {
		if (txid instanceof Uint8Array) txid = hex.encode(txid);
		return hex.decode(await fetch(`${api}/tx/${txid}/hex`).then((r) => r.text()));
	};

	let node = $derived.by(() => {
		if (!mnemonic) return;
		const seed = mnemonicToSeedSync(mnemonic, password);
		const root = HDKey.fromMasterSeed(seed, versions);
		return root.derive(`m/84'/0'/0'/0/0`);
	});

	let address = $derived(node ? p2wpkh(node.publicKey).address : undefined);
	let txid = $state();

	let checkBalance = async (e) => {
		e?.preventDefault();
		loading = true;
		utxos = await fetch(`${api}/address/${address}/utxo`).then((r) => r.json());

		balance = 0;
		pending = 0;

		for (let { value, status } of utxos) {
			if (status.confirmed) balance += value;
			else pending += value;
		}

		loading = false;
	};

	let send = async () => {
		let sats = 100000000;
		let b = (n) => (Number(n) / sats).toFixed(8);
		let inputs = [];
		let outputs = [];
		let fee, tx;

		let i = 0;
		let total = 0n;
		let amount = BigInt(amt);

		while (total < amount) {
			total += BigInt(utxos[i].value);
			i++;
			if (i > utxos.length) throw new Error('insufficient funds');
		}

		let change = total - amount;

		tx = new btc.Transaction();

		for await (let { input, vout, txid } of utxos.slice(0, i)) {
			tx.addInput({
				txid,
				index: vout,
				nonWitnessUtxo: await getHex(txid),
				sequence: 0xfffffffd
			});
		}

		tx.addOutputAddress(destination, amount, network);
		tx.addOutputAddress(address, change, network);

		console.log(tx.unsignedTx.length);

		while (i <= utxos.length) {
			fee = BigInt(rate) * BigInt(tx.unsignedTx.length * 2);

			if (fee <= change) {
				let q = new btc.Transaction();
				for (let i = 0; i < tx.inputsLength; i++) {
					let input = tx.getInput(i);

					let nonWitnessUtxo = await getHex(input.txid);
					q.addInput({ ...input, nonWitnessUtxo });
				}
				q.addOutput(tx.getOutput(0));
				q.addOutputAddress(address, change - fee, network);
				tx = q;

				break;
			} else {
				if (i === utxos.length) {
					if (fee > amount) throw new Error('insufficient funds');
					else {
						let q = new btc.Transaction();
						for (let i = 0; i < tx.inputsLength; i++) {
							let input = tx.getInput(i);

							let nonWitnessUtxo = await getHex(input.txid);
							q.addInput({ ...input, nonWitnessUtxo });
						}

						q.addOutputAddress(destination, total - fee, network);

						tx = q;
						break;
					}
				}

				let { txid, vout } = utxos[++i];
				tx.addInput({
					hash: txid,
					index: vout,
					nonWitnessUtxo: await getHex(txid)
				});
			}
		}

		let privkey = node.privateKey;
		for (let i = 0; i < tx.inputsLength; i++) {
			tx.signIdx(privkey, 0);
			let input = tx.getInput(i);
			let utxo = input.nonWitnessUtxo.outputs[input.index];

			inputs = [
				...inputs,
				{
					address: btc.Address(network).encode(btc.OutScript.decode(utxo.script)),
					amount: b(utxo.amount)
				}
			];
		}

		outputs = tx.outputs.map((o) => ({
			address: btc.Address(network).encode(btc.OutScript.decode(o.script)),
			amount: b(o.amount)
		}));

		tx.finalize();

		txid = await fetch(`${api}/tx`, {
			method: 'POST',
			body: tx.hex
		}).then((r) => r.text());
	};
</script>

<form class="space-y-5" onsubmit={checkBalance}>
	<div class="flex items-center gap-2">
		<textarea use:focus class="textarea grow" placeholder="Seed phrase" bind:value={mnemonic}
		></textarea>
		<button type="button" class="btn flex gap-1" onclick={generate}>
			<img src="/random.svg" class="w-8" />
			<div>Generate</div>
		</button>
	</div>

	<input class="input w-full" placeholder="Passphrase" bind:value={password} />

	{#if address}
		<div class="flex items-center gap-2">
			<div>
				Address: {address}
			</div>

			<button type="submit" class="btn ml-auto"> Check balance </button>
		</div>
	{/if}
</form>

{#if loading}
	<div>
		<div class="loading loading-spinner"></div>
	</div>
{:else if typeof balance !== 'undefined'}
	<div class="flex items-center gap-2">
		<div>
			Balance: {balance} sats
			{#if pending}
				<span class="text-orange-600">({pending} pending)</span>
			{/if}
		</div>
		{#if balance + pending > 0}
			<button type="submit" class="btn ml-auto" onclick={() => (withdrawing = true)}>
				Withdraw</button
			>
		{/if}
	</div>
{/if}

{#if txid}
	<a href={`https://mempool.space/tx/${txid}`}>{txid}</a>
{:else if withdrawing}
	<input class="input w-full" placeholder="Destination address" bind:value={destination} />

	<input class="input w-full" placeholder="Amount" bind:value={amt} />

	<button type="submit" class="btn ml-auto" onclick={send}> Send</button>
{/if}
