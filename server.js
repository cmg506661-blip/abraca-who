const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

let players = [];
let deck = [];
let discardPile = []; 
let turnIndex = 0;
let gameStarted = false;
let pendingAttack = null;

const cardNames = {
    6: '👻고스트(6)', 5: '🧛뱀파이어(5)', 4: '⚔️갑옷기사(4)', 
    3: '🎩집사(3)', 2: '🍳요리사(2)', 1: '🧹청소부(1)'
};

function initDeck() {
    deck = [6, 5,5, 4,4,4, 3,3,3,3, 2,2,2,2,2, 1,1,1,1,1,1];
    deck.sort(() => Math.random() - 0.5);
    discardPile = [];
}

function discardCard(cardNum) {
    if (cardNum === 0) return;
    
    if (cardNum === 6) {
        deck.push(6); 
        deck.sort(() => Math.random() - 0.5); 
        io.emit('gameLog', "👻 고스트가 모습을 드러낸 후 다시 어둠 속(더미)으로 숨어들었습니다!");
    } else {
        discardPile.push(cardNum); 
    }
}

function drawCard() {
    if (deck.length === 0) {
        if (discardPile.length > 0) {
            deck = [...discardPile];
            discardPile = [];
            deck.sort(() => Math.random() - 0.5);
            io.emit('gameLog', "🔄 카드 더미가 다 떨어져, 사용된 카드를 다시 섞습니다.");
        } else {
            initDeck(); 
        }
    }
    return deck.shift();
}

function nextTurn() {
    let aliveCount = players.filter(p => p.hp > 0).length;
    if (aliveCount <= 1) return; 

    do {
        turnIndex = (turnIndex + 1) % players.length;
    } while (players[turnIndex].hp <= 0);
}

function checkGameState(msg) {
    let alivePlayers = players.filter(p => p.hp > 0);
    let stoneWinner = players.find(p => p.stone >= 7);
    let isOver = false;

    if (stoneWinner) {
        msg += `\n\n👑 ${stoneWinner.name}님이 신비한 돌 7개를 모아 최종 우승했습니다!`;
        isOver = true;
    } else if (alivePlayers.length === 1) {
        msg += `\n\n👑 최후의 생존자, ${alivePlayers[0].name}님이 최종 우승했습니다!`;
        isOver = true;
    } else if (alivePlayers.length === 0) {
        msg += `\n\n무승부! 모두가 쓰러졌습니다.`;
        isOver = true;
    }

    return { msg, isOver };
}

function cleanUpDeadPlayers() {
    players.forEach(p => {
        if (p.hp <= 0 && p.card !== 0) {
            discardCard(p.card);
            p.card = 0;
        }
    });
}

io.on('connection', (socket) => {

    socket.on('joinGame', (nickname) => {
        let finalName = nickname || `마법사 ${players.length + 1}`;

        // 🌟 수정: 게임 중이거나 결과창 대기 시간일 때 거절하지 않고 관전자(HP 0)로 입장시킴
        let newPlayer = {
            id: socket.id,
            name: finalName,
            hp: gameStarted ? 0 : 5, // 게임 중이면 관전자로 시작
            stone: 0, 
            card: 0
        };
        players.push(newPlayer);
        socket.emit('joinSuccess');

        if (gameStarted) {
            socket.emit('gameState', { players, turnIndex, log: "진행 중인 게임에 관전자로 참가했습니다.\n잠시 후 다음 라운드가 시작됩니다.", isOver: false, pendingAttack: pendingAttack ? pendingAttack.defender.id : null, discardPile });
        }
        
        io.emit('lobbyUpdate', players);
    });

    socket.on('startGame', () => {
        if (players.length < 2) return;
        gameStarted = true;
        turnIndex = 0; 
        pendingAttack = null; 
        initDeck();
        players.forEach(p => {
            p.hp = 5;
            p.stone = 0;
            p.card = drawCard();
        });
        io.emit('gameState', { players, turnIndex, log: "🚀 게임이 시작되었습니다! 마법사들의 대결이 펼쳐집니다.", isOver: false, pendingAttack: null, discardPile });
    });

    socket.on('actionDuelRequest', (targetId) => {
        let me = players.find(p => p.id === socket.id);
        let target = players.find(p => p.id === targetId);
        
        // 🌟 가드: 서버 뻗음(502) 완벽 차단
        if (!me || !target || me.hp <= 0) return; 
        
        pendingAttack = { attacker: me, defender: target };

        io.emit('gameState', { 
            players, 
            turnIndex, 
            log: `⚔️ <b>[${me.name}]</b>님이 <b>[${target.name}]</b>님에게 결투를 신청했습니다!\n방어자의 응답을 기다리는 중...`, 
            isOver: false,
            pendingAttack: pendingAttack.defender.id,
            discardPile
        });
    });

    socket.on('respondToAttack', (data) => {
        if (!pendingAttack || pendingAttack.defender.id !== socket.id) return;

        let attacker = pendingAttack.attacker;
        let defender = pendingAttack.defender;
        
        // 🌟 가드: 결투 중 누군가 새로고침해서 정보가 꼬였을 때 뻗지 않도록 차단
        let actualAttacker = players.find(p => p.id === attacker.id);
        let actualDefender = players.find(p => p.id === defender.id);
        if (!actualAttacker || !actualDefender) {
            pendingAttack = null;
            nextTurn();
            io.emit('gameState', { players, turnIndex, log: "⚠️ 누군가의 연결이 끊겨 결투가 취소되었습니다.", isOver: false, pendingAttack: null, discardPile });
            return;
        }

        let msg = "";

        if (data.type === 'duel') {
            let aNum = actualAttacker.card;
            let dNum = actualDefender.card;
            msg = `⚔️ <b>[${actualDefender.name}]</b>님이 결투를 수락했습니다!\n공격(${cardNames[aNum]}) VS 수비(${cardNames[dNum]})\n\n`;

            if (aNum === 1 && dNum === 6) {
                msg += "🎉 🧹청소부가 👻고스트를 퇴치했습니다! 방어자(고스트) 즉시 탈락!"; actualDefender.hp = 0; actualAttacker.stone++;
            } else if (aNum === 6 && dNum === 1) {
                msg += "💀 👻고스트가 🧹청소부에게 쫓겨납니다. 공격자(고스트) 즉시 탈락!"; actualAttacker.hp = 0; actualDefender.stone++;
            } else if (aNum === 2 && dNum === 5) {
                msg += "🎉 🍳요리사가 🧛뱀파이어를 물리쳤습니다! 방어자(뱀파이어) 즉시 탈락!"; actualDefender.hp = 0; actualAttacker.stone++;
            } else if (aNum === 5 && dNum === 2) {
                msg += "💀 🧛뱀파이어가 🍳요리사에게 당했습니다. 공격자(뱀파이어) 즉시 탈락!"; actualAttacker.hp = 0; actualDefender.stone++;
            } else if (aNum > dNum) {
                let damage = aNum - dNum;
                msg += `🎉 공격 성공! 파워 차이만큼 방어자의 체력이 ${damage} 깎입니다.`; 
                actualDefender.hp -= damage;
            } else if (aNum < dNum) {
                let damage = dNum - aNum;
                msg += `💀 공격 실패... 파워 차이만큼 역공을 당해 공격자의 체력이 ${damage} 깎입니다.`; 
                actualAttacker.hp -= damage;
            } else {
                msg += "🤝 챙챙! 힘이 같아 아무 일도 일어나지 않습니다.";
            }

            discardCard(actualAttacker.card); 
            actualAttacker.card = drawCard(); 
        } else if (data.type === 'guess') {
            let pNum = actualDefender.card;
            let guessedNumber = data.guessNum;
            msg = `🤔 <b>[${actualDefender.name}]</b>님이 결투를 피하고 정체 추리로 반격합니다!\n"내 카드는 분명 [${guessedNumber}]일 것이다!"\n\n`;

            if (guessedNumber === pNum) {
                msg += `🎉 추리 성공! 진짜 카드는 <b>[${cardNames[pNum]}]</b>였습니다!\n결투는 무효화되고 ✨<b>[마법 효과 발동]</b>✨\n`;
                switch(pNum) {
                    case 6: msg += "👻고스트: 나머지 전원 즉시 탈락!"; players.forEach(p => { if (p.id !== actualDefender.id) p.hp = 0; }); break;
                    case 5: msg += "🧛뱀파이어: 신비한 돌 +2개 획득!"; actualDefender.stone += 2; break;
                    case 4: msg += "⚔️갑옷기사: 나머지 전원에게 2 피해!"; players.forEach(p => { if (p.id !== actualDefender.id && p.hp > 0) p.hp -= 2; }); break;
                    case 3: msg += "🎩집사: 자신 체력 1 회복, 나머지 전원 1 피해!"; actualDefender.hp++; players.forEach(p => { if (p.id !== actualDefender.id && p.hp > 0) p.hp -= 1; }); break;
                    case 2: msg += "🍳요리사: 신비한 돌 +1개 획득!"; actualDefender.stone++; break;
                    case 1: 
                        if (deck.length > 0) {
                            let peekCard = deck.shift();
                            deck.push(peekCard);
                            msg += `🧹청소부: 카드 더미 맨 위를 몰래 확인하고 맨 아래로 숨겼습니다.`; 
                            io.to(socket.id).emit('privateLog', `🤫 <b>[비밀 정보]</b><br>덱 맨 위에서 확인한 카드는 <b>[${cardNames[peekCard]}]</b> 였으며, 맨 아래로 보냈습니다!`);
                        }
                        break; 
                }
            } else {
                msg += `💀 펑! 추리 실패...\n진짜 카드는 <b>[${cardNames[pNum]}]</b>였습니다. 페널티로 방어자의 체력이 1 깎입니다.`;
                actualDefender.hp--;
            }
            discardCard(actualDefender.card); 
            actualDefender.card = drawCard(); 
        }

        cleanUpDeadPlayers();
        pendingAttack = null; 
        let state = checkGameState(msg);
        
        if (state.isOver) {
            setTimeout(() => {
                gameStarted = false;
                players.forEach(p => {
                    p.hp = 5;
                    p.stone = 0;
                    p.card = 0;
                });
                io.emit('lobbyUpdate', players);
            }, 5000);
        } else {
            nextTurn();
        }
        
        io.emit('gameState', { players, turnIndex, log: state.msg, isOver: state.isOver, pendingAttack: null, discardPile });
    });

    socket.on('actionGuess', (guessedNumber) => {
        let me = players.find(p => p.id === socket.id);
        if (!me) return; // 🌟 가드 적용

        let pNum = me.card;
        let msg = `🤔 <b>[${me.name}]</b>의 추리:\n"내 카드는 분명 [${guessedNumber}]일 것이다!"\n\n`;

        if (guessedNumber === pNum) {
            msg += `🎉 추리 성공! 진짜 카드는 <b>[${cardNames[pNum]}]</b>였습니다!\n✨ <b>[강력 마법 효과 발동]</b> ✨\n`;
            switch(pNum) {
                case 6: msg += "👻고스트: 나머지 전원 즉시 탈락!"; players.forEach(p => { if (p.id !== me.id) p.hp = 0; }); break;
                case 5: msg += "🧛뱀파이어: 신비한 돌 +2개 획득!"; me.stone += 2; break;
                case 4: msg += "⚔️갑옷기사: 나머지 전원에게 2 피해!"; players.forEach(p => { if (p.id !== me.id && p.hp > 0) p.hp -= 2; }); break;
                case 3: msg += "🎩집사: 자신 체력 1 회복, 나머지 전원 1 피해!"; me.hp++; players.forEach(p => { if (p.id !== me.id && p.hp > 0) p.hp -= 1; }); break;
                case 2: msg += "🍳요리사: 신비한 돌 +1개 획득!"; me.stone++; break;
                case 1: 
                    if (deck.length > 0) {
                        let peekCard = deck.shift();
                        deck.push(peekCard);
                        msg += `🧹청소부: 카드 더미 맨 위를 몰래 확인하고 맨 아래로 숨겼습니다.`; 
                        io.to(socket.id).emit('privateLog', `🤫 <b>[비밀 정보]</b><br>덱 맨 위에서 확인한 카드는 <b>[${cardNames[peekCard]}]</b> 였으며, 맨 아래로 보냈습니다!`);
                    }
                    break; 
            }
        } else {
            msg += `💀 펑! 추리 실패...\n진짜 카드는 <b>[${cardNames[pNum]}]</b>였습니다. 페널티로 체력이 1 깎입니다.`;
            me.hp--;
        }

        discardCard(me.card); 
        me.card = drawCard(); 
        
        cleanUpDeadPlayers();
        let state = checkGameState(msg);
        
        if (state.isOver) {
            setTimeout(() => {
                gameStarted = false;
                players.forEach(p => {
                    p.hp = 5;
                    p.stone = 0;
                    p.card = 0;
                });
                io.emit('lobbyUpdate', players);
            }, 5000);
        } else {
            nextTurn();
        }
        
        io.emit('gameState', { players, turnIndex, log: state.msg, isOver: state.isOver, pendingAttack: null, discardPile });
    });

    socket.on('disconnect', () => {
        // 🌟 수정: 누군가 나갔을 때 턴이 꼬여서 뻗는 현상 방지
        let index = players.findIndex(p => p.id === socket.id);
        if (index !== -1) {
            players.splice(index, 1);
            if (turnIndex >= players.length) turnIndex = 0;
        }

        if (gameStarted && players.length < 2) {
            gameStarted = false;
            io.emit('gameLog', "🛑 다른 플레이어들이 모두 나가서 게임이 강제 종료되었습니다.");
            setTimeout(() => { io.emit('lobbyUpdate', players); }, 3000);
        } else if (!gameStarted) {
            io.emit('lobbyUpdate', players);
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`✨ 서버가 ${PORT}번 포트에서 열렸습니다!`);
});
