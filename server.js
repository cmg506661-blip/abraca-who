const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

let players = [];
let deck = [];
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
}

function drawCard() {
    if (deck.length === 0) initDeck();
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

io.on('connection', (socket) => {
    // 접속 시 바로 플레이어로 등록하지 않고 대기합니다.

    // 🌟 플레이어가 닉네임을 입력하고 입장 버튼을 눌렀을 때 실행됨
    socket.on('joinGame', (nickname) => {
        if (gameStarted) {
            socket.emit('gameLog', "이미 게임이 시작되어 입장할 수 없습니다.");
            return;
        }

        // 입력한 닉네임이 없으면 '마법사 X'로 기본 설정
        let finalName = nickname || `마법사 ${players.length + 1}`;

        let newPlayer = {
            id: socket.id,
            name: finalName,
            hp: 5, stone: 0, card: 0
        };
        players.push(newPlayer);
        
        io.emit('lobbyUpdate', players);
    });

    socket.on('startGame', () => {
        if (players.length < 2) return;
        gameStarted = true;
        initDeck();
        players.forEach(p => p.card = drawCard());
        io.emit('gameState', { players, turnIndex, log: "🚀 게임이 시작되었습니다! 마법사들의 대결이 펼쳐집니다." });
    });

    socket.on('actionDuelRequest', (targetId) => {
        let me = players.find(p => p.id === socket.id);
        let target = players.find(p => p.id === targetId);
        
        pendingAttack = { attacker: me, defender: target };

        io.emit('gameState', { 
            players, 
            turnIndex, 
            log: `⚔️ <b>[${me.name}]</b>님이 <b>[${target.name}]</b>님에게 결투를 신청했습니다!\n방어자의 응답을 기다리는 중...`, 
            isOver: false,
            pendingAttack: pendingAttack.defender.id 
        });
    });

    socket.on('respondToAttack', (data) => {
        if (!pendingAttack || pendingAttack.defender.id !== socket.id) return;

        let attacker = pendingAttack.attacker;
        let defender = pendingAttack.defender;
        let msg = "";

        if (data.type === 'duel') {
            let aNum = attacker.card;
            let dNum = defender.card;
            msg = `⚔️ <b>[${defender.name}]</b>님이 결투를 수락했습니다!\n공격(${cardNames[aNum]}) VS 수비(${cardNames[dNum]})\n\n`;

            if (aNum === 1 && dNum === 6) {
                msg += "🎉 🧹청소부가 👻고스트를 잡았습니다!"; defender.hp--; attacker.stone++;
            } else if (aNum === 6 && dNum === 1) {
                msg += "💀 👻고스트가 🧹청소부에게 쫓겨납니다."; attacker.hp--; defender.stone++;
            } else if (aNum === 2 && dNum === 5) {
                msg += "🎉 🍳요리사가 🧛뱀파이어를 이겼습니다!"; defender.hp--; attacker.stone++;
            } else if (aNum === 5 && dNum === 2) {
                msg += "💀 🧛뱀파이어가 🍳요리사에게 당했습니다."; attacker.hp--; defender.stone++;
            } else if (aNum > dNum) {
                msg += `🎉 공격 성공! 방어자의 체력이 1 깎입니다.`; defender.hp--;
            } else if (aNum < dNum) {
                msg += `💀 공격 실패... 역공을 당해 공격자의 체력이 1 깎입니다.`; attacker.hp--;
            } else {
                msg += "🤝 챙챙! 힘이 같아 아무 일도 일어나지 않습니다.";
            }

            attacker.card = drawCard(); 
        } else if (data.type === 'guess') {
            let pNum = defender.card;
            let guessedNumber = data.guessNum;
            msg = `🤔 <b>[${defender.name}]</b>님이 결투를 피하고 정체 추리로 반격합니다!\n"내 카드는 분명 [${guessedNumber}]일 것이다!"\n\n`;

            if (guessedNumber === pNum) {
                msg += `🎉 추리 성공! 진짜 카드는 <b>[${cardNames[pNum]}]</b>였습니다!\n결투는 무효화되고 ✨<b>[마법 효과 발동]</b>✨\n`;
                switch(pNum) {
                    case 6: msg += "👻고스트: 나머지 전원 즉시 탈락!"; players.forEach(p => { if (p.id !== defender.id) p.hp = 0; }); break;
                    case 5: msg += "🧛뱀파이어: 신비한 돌 +2개 획득!"; defender.stone += 2; break;
                    case 4: msg += "⚔️갑옷기사: 나머지 전원에게 2 피해!"; players.forEach(p => { if (p.id !== defender.id && p.hp > 0) p.hp -= 2; }); break;
                    case 3: msg += "🎩집사: 자신 체력 1 회복, 나머지 전원 1 피해!"; defender.hp++; players.forEach(p => { if (p.id !== defender.id && p.hp > 0) p.hp -= 1; }); break;
                    case 2: msg += "🍳요리사: 신비한 돌 +1개 획득!"; defender.stone++; break;
                    case 1: msg += `🧹청소부: 카드 더미 훔쳐보기를 사용했습니다.`; break; 
                }
            } else {
                msg += `💀 펑! 추리 실패...\n진짜 카드는 <b>[${cardNames[pNum]}]</b>였습니다. 페널티로 방어자의 체력이 1 깎입니다.`;
                defender.hp--;
            }
            defender.card = drawCard(); 
        }

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
        
        io.emit('gameState', { players, turnIndex, log: state.msg, isOver: state.isOver });
    });

    socket.on('actionGuess', (guessedNumber) => {
        let me = players.find(p => p.id === socket.id);
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
                case 1: msg += `🧹청소부: 카드 더미 훔쳐보기를 사용했습니다.`; break; 
            }
        } else {
            msg += `💀 펑! 추리 실패...\n진짜 카드는 <b>[${cardNames[pNum]}]</b>였습니다. 페널티로 체력이 1 깎입니다.`;
            me.hp--;
        }

        me.card = drawCard(); 

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
        
        io.emit('gameState', { players, turnIndex, log: state.msg, isOver: state.isOver });
    });

    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        if (!gameStarted) io.emit('lobbyUpdate', players);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`✨ 서버가 ${PORT}번 포트에서 열렸습니다!`);
});
