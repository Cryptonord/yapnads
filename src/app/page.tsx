"use client";
import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import EthCrypto from 'eth-crypto';

// --- CONFIGURATION ---
// REPLACE THIS WITH YOUR DEPLOYED MAINNET ADDRESS
const CONTRACT_ADDRESS = "0xf0961d0DFc53595A30cE7E1CDA4E70409C736f18";

const ABI = [
  "function registerSession(string _sessionPubKey, address _burnerAddress) external payable",
  "function sendMessage(address _to, string _encryptedContent) external",
  "function userSessionKeys(address) view returns (string)",
  "event MessageSent(address indexed from, address indexed to, string encryptedContent, uint256 timestamp)"
];

export default function Home() {
  // --- STATE ---
  const [rpcUrl, setRpcUrl] = useState("https://rpc.monad.fastlane.xyz/eyJhIjoiMHg3RTRFMTcxQjRkQWFjQWNkMjU5NTA4NkQ0QTg0MzQ0NGIxOTU4N2IxIiwidCI6MTc2NDQxMzE4OCwicyI6IjB4OTc0OWZlYWMxNmY2ZDQ1ZWVjNDJjMDlhZWI5YzhkM2JjMDJlOWQ3NzBkOTMxNzdlODY2ODBjOTBhZjFjNmM0NjQyZDUyYzRiMWRiYzZjMDkzYTY5MTQ0ZTAwMjc0YzY3YjE2OWFjYzAxY2RkYWUxNDdhODMxZTUyNmIwYjJhNmQxYyJ9"); // Default to Mainnet
  const [mainAccount, setMainAccount] = useState<string>("");
  const [burnerWallet, setBurnerWallet] = useState<ethers.Wallet | null>(null);

  // NEW: Balance & Private Key Visibility
  const [burnerBalance, setBurnerBalance] = useState("0.0");
  const [showPrivateKey, setShowPrivateKey] = useState(false);

  const [recipient, setRecipient] = useState("");
  const [messageText, setMessageText] = useState("");
  const [chatHistory, setChatHistory] = useState<any[]>([]);
  const [status, setStatus] = useState("Idle");

  // --- 1. SETUP SESSION (BURNER WALLET) ---
  useEffect(() => {
    const storedKey = localStorage.getItem("monad_burner_key");
    if (storedKey) {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(storedKey, provider);
      setBurnerWallet(wallet);
      updateBalance(wallet, provider); // Check balance immediately
    }
  }, [rpcUrl]);

  const createSession = () => {
    const randomWallet = ethers.Wallet.createRandom();
    localStorage.setItem("monad_burner_key", randomWallet.privateKey);
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = randomWallet.connect(provider);
    setBurnerWallet(wallet);
    alert("Session Created! Please fund the new wallet.");
  };

  // --- NEW: BALANCE CHECKER ---
  const updateBalance = async (wallet: ethers.Wallet, provider: ethers.JsonRpcProvider) => {
    try {
      const bal = await provider.getBalance(wallet.address);
      setBurnerBalance(ethers.formatEther(bal));
    } catch (e) {
      console.log("Balance check failed (RPC issue?)");
    }
  };

  // --- 2. CONNECT MAIN WALLET & REGISTER ---
  const connectMain = async () => {
    if (!(window as any).ethereum) return alert("Install MetaMask");
    const provider = new ethers.BrowserProvider((window as any).ethereum);

    const network = await provider.getNetwork();
    console.log("Detected Chain ID:", network.chainId); // Check Console to verify!

    // FIX: Update to 143
    if (network.chainId !== 143n) {
      try {
        // Auto-switch to Chain ID 143 (Hex: 0x8F)
        await (window as any).ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: '0x8F' }],
        });
        // Refresh provider after switch
        const newProvider = new ethers.BrowserProvider((window as any).ethereum);
        const signer = await newProvider.getSigner();
        setMainAccount(await signer.getAddress());
        return;
      } catch (e) {
        // If switch fails, just alert
        alert(`⚠️ Wrong Network! Detected: ${network.chainId}. Please switch MetaMask to Chain ID 143.`);
        return;
      }
    }

    const signer = await provider.getSigner();
    setMainAccount(await signer.getAddress());
  };

  const registerOnChain = async () => {
    if (!burnerWallet) return alert("Create Session First");
    setStatus("Registering...");

    try {
      const pubKey = EthCrypto.publicKeyByPrivateKey(burnerWallet.privateKey);
      const provider = new ethers.BrowserProvider((window as any).ethereum);
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

      console.log("Registering session...");
      console.log("Public Key:", pubKey);
      console.log("Burner Address:", burnerWallet.address);

      // Send 0.05 MON to fund the burner wallet during registration
      const fundAmount = ethers.parseEther("0.05");

      const tx = await contract.registerSession(pubKey, burnerWallet.address, {
        value: fundAmount,
        gasLimit: 500000 // Sufficient for registration + transfer
      });

      setStatus("Tx Sent! Waiting for confirmation...");
      await tx.wait();
      setStatus("Registered! Burner wallet funded with 0.05 MON.");

      // Update balance immediately after registration
      if (burnerWallet) {
        const rpcProvider = new ethers.JsonRpcProvider(rpcUrl);
        updateBalance(burnerWallet, rpcProvider);
      }
    } catch (e: any) {
      console.error("Registration Error:", e);

      // Better error handling
      if (e.code === "ACTION_REJECTED" || e.code === 4001) {
        setStatus("Registration Cancelled");
      } else {
        setStatus("Registration Failed: " + (e.reason || e.message));
        alert("Registration Failed: " + (e.reason || e.message));
      }
    }
  };

  // --- 3. SEND MESSAGE (BULLETPROOF VERSION) ---
  const sendMessage = async () => {
    // 1. Basic Checks
    if (!burnerWallet) return alert("No Session Active");
    if (!recipient) return alert("Enter a Recipient Address");

    setStatus("Checking User...");

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    // CONNECT with the BURNER wallet (Signer)
    const connectedBurner = burnerWallet.connect(provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, connectedBurner);

    try {
      // 2. Check if Recipient is Registered on THIS SPECIFIC Contract
      const recipientPubKey = await contract.userSessionKeys(recipient);

      // CRITICAL FIX: If string is empty, they are a "Ghost User" (registered on old contract)
      if (!recipientPubKey || recipientPubKey.length < 10) {
        alert("⚠️ This user has not registered on the NEW contract yet.\n\nTell them to click 'Register On-Chain' again!");
        setStatus("Failed: Recipient not found");
        return;
      }

      setStatus("Encrypting...");
      const encrypted = await EthCrypto.encryptWithPublicKey(recipientPubKey, messageText);
      const cipherString = EthCrypto.cipher.stringify(encrypted);

      setStatus("Sending...");

      // 3. HARDCODED GAS LIMIT (Fixes "Estimation Failed" / "Internal JSON-RPC error")
      const tx = await contract.sendMessage(recipient, cipherString, {
        gasLimit: 500000 // Force the transaction through
      });

      setStatus("Tx Sent! Waiting...");
      await tx.wait();

      setStatus("Message Sent!");
      setMessageText("");
      fetchData();
    } catch (e: any) {
      console.error("Send Error:", e);

      // 4. BETTER ERROR MESSAGING
      if (e.message.includes("insufficient funds")) {
        alert("❌ BURNER WALLET IS EMPTY!\n\nSend 0.05 MON to: " + burnerWallet.address);
      } else {
        alert("Send Failed: " + (e.reason || e.message));
      }
      setStatus("Send Failed");
    }
  };

  // --- 4. POLLING LOOP (Messages + Balance) ---
  const fetchData = async () => {
    if (!burnerWallet || !mainAccount) return;

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

    // A. Update Balance
    updateBalance(burnerWallet, provider);

    // B. Fetch Messages (Limit 100 blocks for public RPC)
    try {
      const filterTo = contract.filters.MessageSent(null, mainAccount);
      const filterFrom = contract.filters.MessageSent(mainAccount, null);

      const logsTo = await contract.queryFilter(filterTo, -100);
      const logsFrom = await contract.queryFilter(filterFrom, -100);

      const allLogs = [...logsTo, ...logsFrom].sort((a: any, b: any) => a.blockNumber - b.blockNumber);

      const decoded = await Promise.all(allLogs.map(async (log: any) => {
        try {
          const parsedLog = contract.interface.parseLog({ topics: log.topics.slice(), data: log.data });
          const { from, encryptedContent, timestamp } = parsedLog!.args;

          const cipher = EthCrypto.cipher.parse(encryptedContent);
          const plainText = await EthCrypto.decryptWithPrivateKey(burnerWallet.privateKey, cipher);

          return { from, text: plainText, timestamp: Number(timestamp), id: log.transactionHash };
        } catch (e) { return null; }
      }));

      setChatHistory(decoded.filter(m => m !== null));
    } catch (e) {
      console.log("Polling error (ignoring)");
    }
  };

  // Poll every 5 seconds
  useEffect(() => {
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [burnerWallet, mainAccount]);

  // --- UI RENDER ---
  return (
    <div className="min-h-screen bg-black text-white p-4 font-mono">
      <div className="max-w-2xl mx-auto space-y-4">

        {/* HEADER */}
        <div className="flex justify-between items-center border-b border-gray-800 pb-2">
          <h1 className="text-xl font-bold text-purple-400">MONAD CHAT (MAINNET)</h1>
          <input
            className="bg-gray-900 border border-gray-700 p-1 rounded text-xs w-48 text-gray-500"
            value={rpcUrl}
            onChange={(e) => setRpcUrl(e.target.value)}
            placeholder="Custom RPC URL"
          />
        </div>

        {/* SESSION MANAGER */}
        <div className="bg-gray-900 p-4 rounded border border-gray-800">
          <div className="flex flex-col gap-3">
            <div className="flex gap-2">
              <button onClick={connectMain} className="flex-1 bg-blue-700 hover:bg-blue-600 px-3 py-2 rounded text-xs font-bold">
                {mainAccount ? `1. Main: ${mainAccount.slice(0, 6)}...` : "1. Connect Identity"}
              </button>

              {!burnerWallet && (
                <button onClick={createSession} className="flex-1 bg-green-700 hover:bg-green-600 px-3 py-2 rounded text-xs font-bold">
                  2. Start Session
                </button>
              )}
            </div>

            {burnerWallet && (
              <div className="bg-black border border-gray-700 p-3 rounded">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="text-xs text-green-400 font-bold mb-1">SESSION ACTIVE</p>
                    <p className="text-xs text-gray-400 break-all select-all font-mono">{burnerWallet.address}</p>
                  </div>
                  <div className={`text-right ${parseFloat(burnerBalance) > 0 ? 'text-green-400' : 'text-red-500'}`}>
                    <p className="text-xs font-bold">Balance</p>
                    <p className="text-sm">{parseFloat(burnerBalance).toFixed(4)} MON</p>
                  </div>
                </div>

                <div className="mt-3 flex gap-2 border-t border-gray-800 pt-2">
                  <button
                    onClick={() => { navigator.clipboard.writeText(burnerWallet.address); alert("Copied Address!"); }}
                    className="bg-gray-800 hover:bg-gray-700 text-[10px] px-2 py-1 rounded border border-gray-600"
                  >
                    Copy Address
                  </button>

                  {/* NEW: REVEAL PRIVATE KEY */}
                  <button
                    onClick={() => setShowPrivateKey(!showPrivateKey)}
                    className="bg-gray-800 hover:bg-gray-700 text-[10px] px-2 py-1 rounded border border-gray-600 text-red-400"
                  >
                    {showPrivateKey ? "Hide Key" : "Reveal Private Key (Dust)"}
                  </button>
                </div>

                {/* PRIVATE KEY REVEAL AREA */}
                {showPrivateKey && (
                  <div className="mt-2 p-2 bg-red-900/20 border border-red-900 rounded">
                    <p className="text-[10px] text-red-500 mb-1">PRIVATE KEY (DO NOT SHARE):</p>
                    <p className="text-[10px] break-all font-mono select-all text-red-300">
                      {burnerWallet.privateKey}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          <button onClick={registerOnChain} className="w-full mt-3 bg-purple-800 py-2 rounded text-sm hover:bg-purple-700 disabled:opacity-50" disabled={!mainAccount || !burnerWallet}>
            3. Register On-Chain
          </button>
          <p className="text-center text-[10px] text-gray-500 mt-1 h-3">{status}</p>
        </div>

        {/* CHAT AREA */}
        <div className="bg-gray-900 rounded border border-gray-800 h-[450px] flex flex-col">
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {chatHistory.map((msg) => {
              const isMe = msg.from.toLowerCase() === mainAccount.toLowerCase();
              return (
                <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] p-2 rounded ${isMe ? 'bg-purple-900 text-gray-100 border border-purple-700' : 'bg-gray-800 text-gray-300 border border-gray-700'}`}>
                    <div className="text-[9px] opacity-50 mb-1 font-mono">{msg.from.slice(0, 6)}...</div>
                    <div className="text-sm break-words">{msg.text}</div>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="p-3 bg-black border-t border-gray-800">
            <input
              className="w-full bg-gray-900 border border-gray-700 p-2 rounded mb-2 text-xs text-white"
              placeholder="Recipient Address (0x...)"
              value={recipient}
              onChange={e => setRecipient(e.target.value)}
            />
            <div className="flex gap-2">
              <input
                className="flex-1 bg-gray-900 border border-gray-700 p-2 rounded text-sm text-white"
                placeholder="Type a message..."
                value={messageText}
                onChange={e => setMessageText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
              />
              <button onClick={sendMessage} className="bg-blue-700 px-4 rounded font-bold hover:bg-blue-600 text-sm">
                SEND
              </button>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}