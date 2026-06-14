const zlib = require('zlib');
const crypto = require('crypto');
const session = {lastAck: -1, lastSequence: -1};

var verboseSWGLogging = false;

module.exports.setVerboseLogging = function (enabled) {
    verboseSWGLogging = Boolean(enabled);
    return verboseSWGLogging;
}

module.exports.debug = function () {
    module.exports.setVerboseLogging(true);
    console.log("[SWG Chat Protocol] Verbose logging enabled");
}

var fragments = null, fragmentLength;
var DecodeSOEPacket = module.exports.Decode = function(buf, decrypted) {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf, "hex");
    var SOEHeader = buf.readUInt16BE(0);
    if (SOEHeader > 0x2 && !decrypted) buf = Decrypt(buf);
    var len, opcode;

    if (verboseSWGLogging) {
        console.log(getFullTimestamp() + " - Received " + buf.length +  " byte packet with header 0x" +  SOEHeader.toString(16).toUpperCase().padStart(4, 0)  + " from server."); 
        console.log("Hex: " + buf.toString('hex'));
        console.log("ASCII: " + buf.toString('ascii').replace(/[^A-Za-z0-9!"#$%&'()*+,.\/:;<=>?@\[\] ^_`{|}~-]/g, ' ').split('').join(' '));
    }

    if (SOEHeader == 0x0001) { //This should never happen.  Will log in case it does.
        console.warn(getFullTimestamp() + " - [SWG Chat Protocol] Unexpected SessionRequest received from server.");  
        return [{type: "SessionRequest",
            CRCLength: buf.readUInt32BE(2),
            ConnectionID: buf.readUInt32BE(6).toString(16),
            ClientUDPSize: buf.readUInt32BE(10)
        }];
    }
    else if (SOEHeader == 0x0002) {
        session.type = "SessionResponse";
        session.connectionID = buf.readUInt32BE(2);
        session.CRCSeed = buf.readUInt32BE(6);
        session.CRCLength = buf.readUInt8(10);
        session.UseCompression = buf.readUInt8(11);
        session.SeedSize = buf.readUInt8(12);
        session.ServerUDPSize = buf.readUInt32BE(13);
        session.sequence = 0;
        session.lastAck = -1;
        session.lastSequence = -1;
        session.RequestID = 0;
        return [session];
    }
    else if (SOEHeader == 0x0003) {
        var ret = [];
        var offset = 2;
        while (offset < buf.length - 3) {
            len = buf.readUInt8(offset);
            ret.push(DecodeSOEPacket(buf.subarray(offset + 1, offset + len + 1), true));
              offset += len + 1;
        }
        return ret;
    }
    else if (SOEHeader == 0x0005) {
        var ret = {type: "Disconnect"};
        ret.connectionID = buf.readUInt32BE(2);
        ret.reasonID = buf.readUInt8(6);
        return ret;
    }
    else if (SOEHeader == 0x0008) { 
        //return [{type: "ServerNetStatusUpdate"}];
    }
    else if (SOEHeader == 0x0009) {
        var sequence = buf.readUInt16BE(2);
        if (sequence <= session.lastSequence && !module.exports.analyze) return [];
        session.lastSequence = sequence;
        var operands = buf.readUInt16LE(4);
        var opcode;
        if (operands == 0x1900) {
            var ret = [];
            var offset = 6;
            while (offset < buf.length - 3) {
                var len = buf.readUInt8(offset);
                offset++;
                operands = buf.readUInt16LE(offset);
                opcode = buf.readUInt32LE(offset + 2);
                if (verboseSWGLogging && !ignoreTable[opcode])
                    console.log(getFullTimestamp() + " - Received packet with operands 0x1900, opcode " + opcodeLookup(opcode) + " (0x" +  opcode.toString(16).toLowerCase().padStart(8, 0)  + ") from server."); 
                if (!DecodeSWGPacket[opcode]) {
                    ret.push({type: opcode.toString(16) + " " + len});
                }
                else {
                    var data = buf.subarray(offset + 6, offset + len);
                    if (verboseSWGLogging) {
                        console.log(getFullTimestamp() + " - Received " + data.length +  " byte packet with opcode " + opcodeLookup(opcode) + " (0x" +  opcode.toString(16).toLowerCase().padStart(8, 0)  + ") from server."); 
                        console.log("Hex: " + data.toString('hex'));
                        console.log("ASCII: " + data.toString('ascii').replace(/[^A-Za-z0-9!"#$%&'()*+,.\/:;<=>?@\[\] ^_`{|}~-]/g, ' ').split('').join(' '));
                    }
                    ret.push(DecodeSWGPacket[opcode](data));
                }
                offset += len;
            }
            return ret;
        }
        opcode = buf.readUInt32LE(6);
        if (verboseSWGLogging && !ignoreTable[opcode])
            console.log(getFullTimestamp() + " - Received packet with operands 0x1900, opcode " + opcodeLookup(opcode) + " (0x" +  opcode.toString(16).toLowerCase().padStart(8, 0)  + ") from server.");
        len = buf.length - 7;
         if (!DecodeSWGPacket[opcode])
            return [{type: opcode.toString(16) + " " + len}];
        else
            return [DecodeSWGPacket[opcode](buf.subarray(10, decrypted ? buf.length : -3))];
    }
    else if (SOEHeader == 0x000d) {
        var sequence = buf.readUInt16BE(2);
        if (sequence <= session.lastSequence) return [];
        session.lastSequence = sequence;
        if (fragments == null) {
            fragmentLength = buf.readUInt32BE(4);
            fragments = buf.subarray(8,-3);
        } else {
            fragments = Buffer.concat([fragments, buf.subarray(4, -3)]);
            //console.log("fragment", fragments.length , "/", fragmentLength);
            if (fragments.length == fragmentLength) {
                buf = fragments;
                fragments = null;
                var operands = buf.readUInt16LE(0);
                opcode = buf.readUInt32LE(2);
                if (!DecodeSWGPacket[opcode]) return [{type: opcode.toString(16) + " " + buf.length}];
                var ret = [DecodeSWGPacket[opcode](buf.subarray(6))];
                return ret;
            } else if (fragments.length > fragmentLength) {
                //console.log("extra data fragment", fragments.length , "/", fragmentLength);
                fragments = null;
            }
        }
        return [];
    }
    else if (SOEHeader == 0x0015) {
        return [{type: "Ack", sequence: buf.readUInt16BE(2)}];
    }
    else { //Ignore any other header types
        if (verboseSWGLogging) {
            console.log(getFullTimestamp() + " : Received " + buf.length +  " byte packet with header 0x" +  SOEHeader.toString(16).toLowerCase().padStart(4, 0)  + " from server.");  
            console.log("Hex: " + buf.toString('hex'));
            console.log("ASCII: " + buf.toString('ascii').replace(/[^A-Za-z0-9!"#$%&'()*+,.\/:;<=>?@\[\] ^_`{|}~-]/g, ' ').split('').join(' '));
        }
    }
}

module.exports.Encode = function(type, data) {
    return EncodeSWGPacket[type](data);
}

function Decrypt(bufData) {

    var decrypted = Buffer.alloc(bufData.length);
    decrypted.writeUInt16BE(bufData.readUInt16BE(0), 0);

    var mask = session.CRCSeed;
    //console.log(mask.toString(16));
    var offset = 2;
    for (; offset <= bufData.length - 6; offset += 4) {
        let temp = bufData.readUInt32LE(offset);
        decrypted.writeUInt32LE((temp ^ mask) >>> 0, offset);
        mask = temp;
    }

    mask &= 0xff;

    for (; offset < bufData.length -2; offset++) {
        decrypted.writeUInt8((bufData.readUInt8(offset) ^ mask) >>> 0, offset);
    }

    decrypted.writeUInt16BE(bufData.readUInt16BE(offset), offset);

    if (decrypted.readUInt8(decrypted.length-3) == 1) {
        try {
            return Buffer.concat([decrypted.subarray(0,2), zlib.inflateSync(decrypted.subarray(2, -3)), decrypted.subarray(-3)]);
        }
        catch(err) {}
    }   
    
    return decrypted;
}

function Encrypt(bufData) {
    if (bufData.length > 493) {
        var packets = [];
        //console.log(buf.toString('hex'));
        //console.log(buf.toString('utf16le'));
        var swgPacketSize = 496 - 8 - 3;
        for (var i = 4; i < bufData.length; i += swgPacketSize) {
            var head = Buffer.alloc(i == 4 ? 8 : 4);
            head.writeUInt16BE(0xd, 0);
            head.writeUInt16BE(i > 4 ? session.sequence++ : session.sequence-1, 2);
            if (i == 4) head.writeUInt32BE(bufData.length-4, 4);
            else swgPacketSize = 496 - 4 - 3;
            var b = Buffer.concat([head, bufData.subarray(i, i+swgPacketSize)]);
            //console.log(b.toString('hex'));
            packets.push(Encrypt(b));
        }
        return packets;
    }
    if (bufData.length > 100 || bufData.readUInt16BE(0) == 0xd)
        bufData = Buffer.concat([bufData.subarray(0,2), zlib.deflateSync(bufData.subarray(2)), Buffer.from([1,0,0])]);
    else
        bufData = Buffer.concat([bufData, Buffer.from([0,0,0])]);
    //console.log(bufData.toString('hex'));
    var encrypted = Buffer.alloc(bufData.length);
    encrypted.writeUInt16BE(bufData.readUInt16BE(0), 0);

    var mask = session.CRCSeed;
    var offset = 2;
    for (; offset <= encrypted.length - 6; offset += 4) {
        mask = (bufData.readUInt32LE(offset) ^ mask) >>> 0;
        encrypted.writeUInt32LE(mask, offset);
    }

    mask &= 0xff;

    for (; offset < encrypted.length - 2; offset++) {
        encrypted.writeUInt8((bufData.readUInt8(offset) ^ mask) >>> 0, offset);
    }

    encrypted.writeUInt16BE(GenerateCrc(encrypted.subarray(0,offset), session.CRCSeed) & 0xffff, offset);

    return encrypted;
}

function EncodeSOEHeader(opcode, operands) {
    var buf = Buffer.alloc(10);
    buf.writeUInt16BE(9, 0);
    buf.writeUInt16BE(session.sequence++, 2);
    buf.writeUInt16LE(operands, 4);
    buf.writeUInt32LE(opcode, 6);
    return buf;
}

DecodeSWGPacket = {};
EncodeSWGPacket = {};
EncodeSWGPacket["Ack"] = function() {
    if (session.lastAck >= session.lastSequence) return false;
    var buf = Buffer.alloc(4);
    buf.writeUInt16BE(0x15, 0);
    buf.writeUInt16BE(session.lastSequence, 2);
    session.lastAck = session.lastSequence;
    return Encrypt(buf);
}

EncodeSWGPacket["ClientNetStatusRequest"] = function() {
    var buf = Buffer.alloc(40);                 //Need to send the complete 40 byte packet
    buf.writeUInt16BE(0x07, 0);                 //00 07 - Client Network Status Update
    var tick  = new Date().getTime() & 0xFFFF;  //Convert to uint16
    buf.writeUInt16LE(tick, 2);                 //Convert to little endian (same as htons in c++)
    buf.writeUInt8(0x2, 31);                    //Packets Sent
    buf.writeUint8(0x1, 39);                    //Packets Received
    return Encrypt(buf);
}

EncodeSWGPacket["SessionRequest"] = function() {
    var buf = Buffer.alloc(14);
    buf.writeUInt16BE(1, 0);
    buf.writeUInt32BE(2, 2);
    buf.writeUInt32BE(crypto.randomBytes(4).readUInt32BE(0), 6);
    buf.writeUInt32BE(496, 10);
    return buf;
}

DecodeSWGPacket[0xd5899226] = function(data) {
    var ret = {type: "ClientIdMsg"};
    //console.log("4x0: " + data.subarray(0, 4).toString('hex'));
    var len = data.readUInt32LE(4);
    ret.SessionKey = data.subarray(8, 8+len);
    data.off = 8+len;
    ret.Version = AString(data);
    session.SessionKey = ret.SessionKey
    return ret;
}
EncodeSWGPacket["ClientIdMsg"] = function() {
    var header = EncodeSOEHeader(0xd5899226, 3);
    var buf = Buffer.alloc(496);
    buf.fill(0,0,4);
    buf.off = 4;
    buf.writeUInt32LE(session.SessionKey.length, 4);
    session.SessionKey.copy(buf, 8);
    buf.off = 8 + session.SessionKey.length;
    writeAString(buf, "20050408-18:00");
    buf = buf.subarray(0, buf.off);
    buf = Buffer.concat([header, buf]);
    return Encrypt(buf);
}

DecodeSWGPacket[0x31805ee0] = function() {
    return {type: "LagRequest"};
}
DecodeSWGPacket[0x1590f63c] = function() {
    return {type: "ConectionServerLagResponse"};
}
DecodeSWGPacket[0x789a4e0a] = function() {
    return {type: "GameServerLagResponse"};
}
DecodeSWGPacket[0xe00730e5] = function(data) {
    return {type: "ClientPermissions",
        GalaxyOpenFlag: data.readUInt8(0),
        CharacterSlotOpenFlag: data.readUInt8(1),
        UnlimitedCharCreationFlag: data.readUInt8(2)
    }
}
DecodeSWGPacket[0xc5ed2f85] = function(data) {
    return {type: "LagReport",
        ConnectionServerLag: data.readUInt32LE(0),
        GameServerLag: data.readUInt32LE(4)
    }
}
DecodeSWGPacket[0xb5098d76] = function(data) {
    return {type: "SelectCharacter",
        CharacterID: data.toString("hex")
    }
}
EncodeSWGPacket["SelectCharacter"] = function(data) {
    var header = EncodeSOEHeader(0xb5098d76, 2);
    var buf = Buffer.alloc(8);
    data.CharacterID.copy(buf,0);
    buf = Buffer.concat([header, buf]);
    return Encrypt(buf);
}
DecodeSWGPacket[0x41131f96] = function(data) {
    data.off = 0;
    return {type: "LoginClientID",
        Username: AString(data),
        Password: AString(data),
        Version: AString(data)
    }
}
EncodeSWGPacket["LoginClientID"] = function(data) {
    var header = EncodeSOEHeader(0x41131f96, 4);
    var buf = Buffer.alloc(496);
    buf.off = 0;
    writeAString(buf, data.Username);
    writeAString(buf, data.Password);
    writeAString(buf, "20050408-18:00");
    buf = buf.subarray(0, buf.off);
    buf = Buffer.concat([header, buf]);
    return Encrypt(buf);
}

DecodeSWGPacket[0xaab296c6] = function(data) {
    var len = data.readUInt32LE(0);
    var ret = {type: "LoginClientToken",
        SessionKey: data.subarray(4,len+4),
        StationID: data.readUInt32LE(len+4).toString(16)
    }
    data.off = len + 8;
    ret.UserName = AString(data);
    session.SessionKey = ret.SessionKey;
    return ret;
}
DecodeSWGPacket[0xc11c63b9] = function(data) {
    var ret = {type: "LoginEnumCluster",
        Servers: {}
    }
    var serverCount = data.readUInt32LE(0);
    data.off = 4;
    for (var i = 0; i < serverCount; i++) {
        var server = {ServerID: data.readUInt32LE(data.off).toString(16)};
        data.off += 4;
        server.Name = AString(data);
        server.Distance = data.readInt32LE(data.off);
        data.off += 4;
        ret.Servers[server.ServerID] = server;
    }
    ret.MaxCharsPerAccount = data.readUInt32LE(data.off);
    return ret;
}
DecodeSWGPacket[0x3436aeb6] = function(data) {
    var ret = {type: "LoginClusterStatus",
        Servers: {}
    };
    var serverCount = data.readUInt32LE(0);
    data.off = 4;
    for (var i = 0; i < serverCount; i++) {
        var server = {};
        var ServerID = data.readUInt32LE(data.off).toString(16);
        data.off += 4;
        server.IPAddress = AString(data);
        server.Port = data.readUInt16LE(data.off);
        server.PingPort = data.readUInt16LE(data.off+2);
        server.ServerPopulation = data.readInt32LE(data.off+4);
        server.MaxCapacity = data.readInt32LE(data.off+8);
        server.MaxCharsPerServer = data.readInt32LE(data.off+12);
        server.Distance = data.readInt32LE(data.off+16);
        server.Status = data.readInt32LE(data.off+20);
        server.NotRecommended = data.readInt8(data.off+24);
        data.off += 25;
        ret.Servers[ServerID] = server;
    }
    return ret;
}
DecodeSWGPacket[0x65ea4574] = function(data) {
    var raceGenderLookup = {
        0x060E51D5: "human male",
        0x04FEC8FA: "trandoshan male",
        0x32F6307A: "twilek male",
        0x9B81AD32: "bothan male",
        0x22727757: "zabrak male",
        0xCB8F1F9D: "rodian male",
        0x79BE87A9: "moncal male",
        0x2E3CE884: "wookiee male",
        0x1C95F5BC: "sullstan male",
        0xD3432345: "ithorian male",
        0xD4A72A70: "human female",
        0x64C24976: "trandoshan female",
        0x6F6EB65D: "twilek female",
        0xF6AB978F: "bothan female",
        0x421ABB7C: "zabrak female",
        0x299DC0DA: "rodian female",
        0x73D65B5F: "moncal female",
        0x1AAD09FA: "wookiee female",
        0x44739CC1: "sullstan female",
        0xE7DA1366: "ithorian female"
    };
    var ret = {type: "EnumerateCharacterId",
        Characters: {}
    };
    var characterCount = data.readUInt32LE(0);
    data.off = 4;
    for (var i = 0; i < characterCount; i++) {
        var name = UString(data);
        var raceGender = raceGenderLookup[data.readUInt32LE(data.off)];
        if (!raceGender) raceGender = "unknown unknown";
        raceGender = raceGender.split(" ");
        ret.Characters[name] = {
            Name: name,
            Race: raceGender[0],
            Gender: raceGender[1],
            CharacterID: data.subarray(data.off+4, data.off+12),
            ServerID: data.readUInt32LE(data.off+12).toString(16),
            Satus: data.readUInt32LE(data.off+16)
        };
        data.off += 20;
    }
    return ret;
}

DecodeSWGPacket[0x20e4dbe3] = function(data) {
    var ret = {type:"ChatSendToRoom"};
    data.off = 0;
    ret.Message = UString(data);
    ret.Spacer = data.readUInt32LE(data.off);
    ret.RoomID = data.readUInt32LE(data.off + 4);
    ret = MessageCounter = data.readUInt32LE(data.off + 8);
    //console.log(getFullTimestamp() + " - ChatSendToRoom:  Received " + data.length +  " byte ChatSendToRoom packet with message:  " + ret.Message);
    return ret;
}

messageCounter = 1;
EncodeSWGPacket["ChatSendToRoom"] = function(data) {
    var chatMessage = truncate(data.Message, 2000);    //Going to truncate messages at 2000 characters to stay under the max buffer size of 5000
    var buf = Buffer.concat([EncodeSOEHeader(0x20e4dbe3, 5), Buffer.alloc(chatMessage.length * 2 + 16)]);
    buf.off = 10;
    writeUString(buf, chatMessage);
    buf.fill(0, buf.off, buf.off+4);
    buf.writeUInt32LE(data.RoomID, buf.off+4);
    buf.writeUInt32LE(messageCounter++, buf.off+8);
    return Encrypt(buf);
}

tellCounter = 1;
EncodeSWGPacket["ChatInstantMessageToCharacter"] = function(data) {
    var chatMessage = truncate(data.Message, 2000);    //Going to truncate messages at 2000 characters to stay under the max buffer size of 5000
    var buf = Buffer.concat([EncodeSOEHeader(0x84bb21f7, 5), Buffer.alloc(21 + data.ServerName.length + data.PlayerName.length + chatMessage.length * 2)]);
    buf.off = 10;
    writeAString(buf, "SWG");
    writeAString(buf, data.ServerName);
    writeAString(buf, data.PlayerName);
    writeUString(buf, chatMessage);
    buf.fill(0, buf.off, buf.off+4);
    buf.writeUInt32LE(tellCounter++, buf.off+4);
    //console.log(buf.toString('hex'));
    return Encrypt(buf);
}

DecodeSWGPacket[0x88dbb381] = function(data) {
    var errorCode = data.readUInt32LE(0);
    var status = "Error";
    if (errorCode == 0) status = "Success";
    if (errorCode == 4) status = "Unavailable";
    return {type:"ChatOnSendInstantMessage", Status: status};
}

DecodeSWGPacket[0x3c565ced] = function(data) {
    data.off = 0;
    AString(data);//SWG
    AString(data);//server
    return {type:"ChatInstantMessageToClient", PlayerName: AString(data), Message: UString(data)};
}

DecodeSWGPacket[0x68a75f0c] = function(data) {
    data.off = 0;

    const objectId = data.readBigUInt64LE(data.off).toString();
    data.off += 8;

    const objectType = parseObjectType(data.subarray(data.off, data.off + 4));
    data.off += 4;

    const viewType = data.readUInt8(data.off);
    data.off += 1;

    const dataSize = data.readUInt32LE(data.off);
    data.off += 4;

    const payload = data.subarray(data.off, data.off + dataSize);
    const baseline = {
        type: "BaselinesMessage",
        ObjectID: objectId,
        ObjectType: objectType,
        ViewType: viewType,
        DataSize: dataSize,
        PayloadHex: payload.toString("hex")
    };

    if (objectType === "ITNO" && viewType === 3) {
        baseline.ParsedBaseline = parseItno03Baseline(payload);
    }

    baseline.PayloadHints = extractStringHints(payload);

    return baseline;
}

DecodeSWGPacket[0xcd4ce444] = function(data) {
    var ret = {type: "ChatRoomMessage"};
    data.off = 0;
    AString(data);//SWG
    AString(data);//server
    ret.CharacterName = AString(data);
    ret.RoomID = data.readUInt32LE(data.off)
    data.off += 4;
    ret.Message = UString(data);
    ret.OutOfBandPackage = UString(data);
    //console.log(getFullTimestamp() + " - ChatRoomMessage:  Received " + data.length +  " byte ChatRoomMessage packet from player " + ret.CharacterName + " with message:  " + ret.Message);
    return ret;
}
DecodeSWGPacket[0xe7b61633] = function(data) {
    var ret = {type: "ChatOnSendRoom"};
    ret.ErrorCode = data.readUInt32LE(0);
    ret.MessageID = data.readUInt32LE(4);
    //console.log(getFullTimestamp() + " - ChatOnSendRoom:  Received " + data.length +  " byte ChatOnSendRoom packet with MessageID:  " + ret.MessageID);
    return ret;
}

DecodeSWGPacket[0x43fd1c22] = function() {
    return {type: "CmdSceneReady"};
}
EncodeSWGPacket["CmdSceneReady"] = function() {
    return Encrypt(EncodeSOEHeader(0x43fd1c22, 1));
}

EncodeSWGPacket["ExecuteConsoleCommand"] = function(data) {
    const command = String((data && data.Command) || '');
    const payload = Buffer.alloc(2 + Buffer.byteLength(command, "ascii"));

    payload.off = 0;
    writeAString(payload, command);

    return Encrypt(Buffer.concat([EncodeSOEHeader(0xb1cfce1c, 1), payload.subarray(0, payload.off)]));
}

EncodeSWGPacket["CommandQueueEnqueue"] = function(data) {
    const characterId = data && Buffer.isBuffer(data.CharacterID) ? data.CharacterID : null;
    const argumentsString = String((data && data.Arguments) || '');
    const body = Buffer.alloc(40 + (argumentsString.length * 2));

    if (!characterId || characterId.length !== 8) {
        return false;
    }

    body.off = 0;
    body.writeUInt32LE(0x23, 0);
    body.writeUInt32LE(0x116, 4);
    characterId.copy(body, 8);
    body.writeUInt32LE(0, 16);
    body.writeUInt32LE((data && data.ActionCount) >>> 0, 20);
    body.writeUInt32LE((data && data.CommandCRC) >>> 0, 24);
    body.writeBigUInt64LE(BigInt((data && data.TargetID) || 0), 28);
    body.off = 36;
    writeUString(body, argumentsString);

    return Encrypt(Buffer.concat([EncodeSOEHeader(0x80ce5e46, 5), body.subarray(0, body.off)]));
}

EncodeSWGPacket["ObjectMenuSelectMessage::MESSAGE_TYPE"] = function(data) {
    const objectId = data && data.ObjectID !== undefined && data.ObjectID !== null
        ? BigInt(data.ObjectID)
        : null;
    const radialId = Math.max(0, Math.min(255, Number((data && data.RadialID) || 0)));

    if (objectId === null) {
        return false;
    }

    const payload = Buffer.alloc(9);
    payload.writeBigUInt64LE(objectId, 0);
    payload.writeUInt8(radialId, 8);

    return Encrypt(Buffer.concat([EncodeSOEHeader(0x7ca18726, 3), payload]));
}

DecodeSWGPacket[0xbc6bddf2] = function(data) {
    return {type: "ChatEnterRoomById",
        RequestID: data.readUInt32LE(0),
        RoomID: data.readUInt32LE(4)
    };
}
EncodeSWGPacket["ChatEnterRoomById"] = function(data) {
    var header = EncodeSOEHeader(0xbc6bddf2, 3);
    var buf = Buffer.alloc(8);
    buf.writeUInt32LE(session.RequestID++, 0);
    buf.writeUInt32LE(data.RoomID, 4);
    buf = Buffer.concat([header, buf]);
    return Encrypt(buf);
}

DecodeSWGPacket[0xe69bdc0a] = function(data) {

    var ret = {type: "ChatOnEnteredRoom"};
    data.off = 0;
    AString(data);  //Game Name = SWG
    AString(data);  //Galaxy Name
    ret.PlayerName = AString(data); //Player name is third string
    ret.Error = data.readUInt32LE(data.off);
    ret.RoomID = data.readUInt32LE(data.off+4);
    ret.RequestID = data.readUInt32LE(data.off+8);

    return ret;
}

DecodeSWGPacket[0x60b5098b] = function(data) {

    var ret = {type: "ChatOnLeaveRoom"};
    data.off = 0;
    AString(data); //Game Name = SWG
    AString(data); //Galaxy Name
    ret.PlayerName = AString(data); //Player name is third string
    ret.Error = data.readUInt32LE(data.off);
    ret.RoomID = data.readUInt32LE(data.off+4);
    
    return ret;
}

DecodeSWGPacket[0x9cf2b192] = function(data) {
    data.off = 4;
    return {type: "ChatQueryRoom",
        RequestID: data.readUInt32LE(0),
        RoomPath: AString(data)
    };
}
EncodeSWGPacket["ChatQueryRoom"] = function(data) {
    var header = EncodeSOEHeader(0x9cf2b192, 3);
    var buf = Buffer.alloc(496);
    buf.writeUInt32LE(session.RequestID++, 0);
    buf.off = 4;
    writeAString(buf, data.RoomPath);  

    buf = Buffer.concat([header, buf.subarray(0, buf.off)]);

    return Encrypt(buf);
}

DecodeSWGPacket[0xc4de864e] = function(data) {
    var ret = {type: "ChatQueryRoomResults",
        Players: [],
        Invited: [],
        Moderators: [],
        Banned: []
    };
    var count = data.readUInt32LE(0);
    data.off = 4;
    for (var i = 0; i < count; i++) {
        AString(data);//swg
        AString(data);//galaxy
        ret.Players.push(AString(data));
    }
    var count = data.readUInt32LE(0);
    data.off += 4;
    for (var i = 0; i < count; i++) {
        AString(data);//swg
        AString(data);//galaxy
        ret.Invited.push(AString(data));
    }
    var count = data.readUInt32LE(0);
    data.off += 4;
    for (var i = 0; i < count; i++) {
        AString(data);//swg
        AString(data);//galaxy
        ret.Moderators.push(AString(data));
    }
    var count = data.readUInt32LE(0);
    data.off += 4;
    for (var i = 0; i < count; i++) {
        AString(data);//swg
        AString(data);//galaxy
        ret.Banned.push(AString(data));
    }
    ret.RequestID = data.readUInt32LE(data.off);
    ret.RoomID = data.readUInt32LE(data.off+4);
    ret.IsPublic = data.readUInt32LE(data.off+8) > 0;
    ret.IsModerated = data.readUInt8(data.off+12) > 0;
    data.off += 13;
    ret.RoomPath = AString(data);
    AString(data); //SWG
    AString(data); //galaxy
    ret.Owner = AString(data);
    AString(data); //SWG
    AString(data); //galaxy
    ret.Creator = AString(data);
    ret.Title = UString(data);
    return ret;
}

DecodeSWGPacket[0x70deb197] = function(data) {
    var ret = {type: "ChatRoomList",
        Rooms: {}
    };
    var count = data.readUInt32LE(0);
    data.off = 4;
    for (var i = 0; i < count; i++) {
        var room = {
            RoomID: data.readUInt32LE(data.off),
            IsPublic: data.readUInt32LE(data.off+4) > 0,
            IsModerated: data.readUInt8(data.off+8) > 0
        };
        data.off += 9;
        room.RoomPath = AString(data);
        AString(data); //SWG
        AString(data); //galaxy
        room.Owner = AString(data);
        AString(data); //SWG
        AString(data); //galaxy
        room.Creator = AString(data);
        room.Title = UString(data);
        var moderators = data.readUInt32LE(data.off);
        data.off += 4;
        room.Moderators = [];
        for (var m = 0; m < moderators; m++) {
            AString(data);//SWG
            AString(data);//galaxy
            room.Moderators.push(AString(data));
        }
        var users = data.readUInt32LE(data.off);
        data.off += 4;
        room.Users = [];
        for (var u = 0; u < users; u++) {
            AString(data);//SWG
            AString(data);//galaxy
            room.Users.push(AString(data));
        }
        ret.Rooms[room.RoomID] = room;
    }
    return ret;
}

/*
DecodeSWGPacket[0x80ce5e46] = function() {
    return {type:"ObjectController", TODO: "Main event for interacting with world"}
}
*/

DecodeSWGPacket[0xfe89ddea] = function(data) {
    data.off = 0;

    const packet = {
        type: "SceneCreateObjectByCrc",
        ObjectID: data.readBigUInt64LE(data.off).toString()
    };
    data.off += 8;

    packet.QuaternionX = data.readFloatLE(data.off);
    packet.QuaternionY = data.readFloatLE(data.off + 4);
    packet.QuaternionZ = data.readFloatLE(data.off + 8);
    packet.QuaternionW = data.readFloatLE(data.off + 12);
    data.off += 16;

    packet.PositionX = data.readFloatLE(data.off);
    packet.PositionY = data.readFloatLE(data.off + 4);
    packet.PositionZ = data.readFloatLE(data.off + 8);
    data.off += 12;

    packet.ObjectCRC = data.readUInt32LE(data.off);
    data.off += 4;

    packet.ByteFlag = data.readUInt8(data.off);

    return packet;
}

DecodeSWGPacket[0x56cbde9e] = function(data) {
    data.off = 0;
    return {
        type: "UpdateContainmentMessage",
        ObjectID: data.readBigUInt64LE(data.off).toString(),
        ParentID: data.readBigUInt64LE(data.off + 8).toString(),
        ArrangementID: data.readInt32LE(data.off + 16)
    };
}

DecodeSWGPacket[0x4d45d504] = function(data) {
    return {
        type: "SceneDestroyObject",
        ObjectID: data.readBigUInt64LE(0).toString()
    };
}

DecodeSWGPacket[0xf898e25f] = function(data) {
    data.off = 0;
    return {type:"RequestCategories", Language: AString(data)}
}

DecodeSWGPacket[0x274f4e78] = function(data) {
    return {type:"NewTicketActivity", TicketID: data.readUInt32LE(0)}
}

DecodeSWGPacket[0x0f5d5325] = function(data) {
    return {type:"ClientInactivity", Flag: data.readUInt8(0)}
}

DecodeSWGPacket[0x4c3d2cfa] = function() {
    return {type:"ChatRequestRoomList"}
}

EncodeSWGPacket["ChatRequestRoomList"] = function() {
    return Encrypt(EncodeSOEHeader(0x4c3d2cfa, 1));
}

DecodeSWGPacket[0x2e365218] = function() {
    return {type:"ConnectPlayer"}
}

DecodeSWGPacket[0x35366bed] = function(data) {
    data.off = 4;
    return {type:"ChatCreateRoom",
        PermissionFlag: data.readUInt8(0),
        ModerationFlag: data.readUInt8(1),
        RoomPath: AString(data),
        RoomTitle: AString(data),
        RequestID: data.readUInt32LE(data.off)
    }
}
EncodeSWGPacket["ChatCreateRoom"] = function(data) {
    var header = EncodeSOEHeader(0x35366bed, 7);
    var buf = Buffer.alloc(496);
    buf.writeUInt8(1, 0);
    buf.writeUInt8(0, 1);
    buf.off = 4;
    writeAString(buf, data.RoomPath);
    writeAString(buf, data.RoomTitle || "");
    buf.writeUInt32LE(session.RequestID++, buf.off);
    buf = Buffer.concat([header, buf.subarray(0, buf.off+4)]);
    return Encrypt(buf);

}

DecodeSWGPacket[0x6137556f] = function() {
    return {type:"ConnectPlayerResponse"};
}

DecodeSWGPacket[0x35d7cc9f] = function(data) {
    var ret = {type: "ChatOnCreateRoom",
        Error: data.readUInt32LE(0),
        RoomID: data.readUInt32LE(4),
        IsPublic: !!data.readUInt32LE(8),
        IsModerated: !!data.readUInt8(12),
        Moderators: [],
        Users: []
    };
    data.off = 13;
    ret.RoomPath = AString(data);
    AString(data); //SWG
    AString(data); //server
    ret.Owner = AString(data);
    AString(data); //SWG
    AString(data); //server
    ret.Creator = AString(data);
    ret.Title = UString(data);
    var moderators = data.readUInt32LE(data.off);
    data.off += 4;
    for (var i = 0; i < moderators; i++) {
        AString(data); //SWG
        AString(data); //server
        ret.Moderators.push(AString(data));
    }
    var users = data.readUInt32LE(data.off);
    data.off += 4;
    for (var i = 0; i < users; i++) {
        AString(data); //SWG
        AString(data); //server
        ret.Users.push(AString(data));
    }
    ret.RequestID = data.readUInt32LE(data.off);
    return ret;
}

function AString(buf) {
    var len = buf.readUInt16LE(buf.off);
    var str = buf.subarray(buf.off+2, buf.off+2+len).toString("ascii");
    buf.off += 2 + len;
    return str;
}
function UString(buf) {
    var len = buf.readUInt32LE(buf.off);
    var str = buf.subarray(buf.off+4, buf.off+4+len*2).toString("utf16le");
    buf.off += 4 + len*2;
    return str;
}

function writeAString(buf, str) {
    buf.writeUInt16LE(str.length, buf.off);
    buf.write(str, buf.off + 2, str.length, "ascii");
    buf.off += 2 + str.length;
}
function writeUString(buf, str) {
    buf.writeUInt32LE(str.length, buf.off);
    buf.write(str, buf.off+4, str.length*2, "utf16le");
    buf.off += 4 + str.length*2;
}

function parseObjectType(buf) {
    return Buffer.from(buf)
        .reverse()
        .toString("ascii");
}

function parseItno03Baseline(payload) {
    if (!Buffer.isBuffer(payload) || payload.length < 2) {
        return null;
    }

    payload.off = 0;

    const objectOperandCount = payload.readUInt16LE(payload.off);
    payload.off += 2;

    const complexity = payload.readFloatLE(payload.off);
    payload.off += 4;

    const stfFile = AString(payload);
    const stfSpacer = payload.readInt32LE(payload.off);
    payload.off += 4;

    const stfName = AString(payload);
    const customName = UString(payload);
    const volume = payload.readInt32LE(payload.off);
    payload.off += 4;

    const genericInt = payload.readInt32LE(payload.off);

    return {
        objectOperandCount,
        complexity,
        stfFile,
        stfSpacer,
        stfName,
        customName,
        volume,
        genericInt
    };
}

function extractStringHints(payload) {
    if (!Buffer.isBuffer(payload) || payload.length === 0) {
        return [];
    }

    const hints = new Set();

    const asciiMatches = payload.toString("ascii").match(/[A-Za-z0-9_\/.-]{4,}/g) || [];
    for (const match of asciiMatches) {
        if (/[A-Za-z]/.test(match)) {
            hints.add(match);
        }
    }

    const utf16Matches = payload
        .toString("utf16le")
        .match(/[A-Za-z0-9_\/.-]{4,}/g) || [];
    for (const match of utf16Matches) {
        if (/[A-Za-z]/.test(match)) {
            hints.add(match);
        }
    }

    return Array.from(hints).slice(0, 20);
}

function GenerateCrc(pData, nCrcSeed)
{
    const g_nCrcTable =
    [
    0x00000000, 0x77073096, 0xee0e612c, 0x990951ba, 0x076dc419, 0x706af48f,
    0xe963a535, 0x9e6495a3, 0x0edb8832, 0x79dcb8a4, 0xe0d5e91e, 0x97d2d988,
    0x09b64c2b, 0x7eb17cbd, 0xe7b82d07, 0x90bf1d91, 0x1db71064, 0x6ab020f2,
    0xf3b97148, 0x84be41de, 0x1adad47d, 0x6ddde4eb, 0xf4d4b551, 0x83d385c7,
    0x136c9856, 0x646ba8c0, 0xfd62f97a, 0x8a65c9ec, 0x14015c4f, 0x63066cd9,
    0xfa0f3d63, 0x8d080df5, 0x3b6e20c8, 0x4c69105e, 0xd56041e4, 0xa2677172,
    0x3c03e4d1, 0x4b04d447, 0xd20d85fd, 0xa50ab56b, 0x35b5a8fa, 0x42b2986c,
    0xdbbbc9d6, 0xacbcf940, 0x32d86ce3, 0x45df5c75, 0xdcd60dcf, 0xabd13d59,
    0x26d930ac, 0x51de003a, 0xc8d75180, 0xbfd06116, 0x21b4f4b5, 0x56b3c423,
    0xcfba9599, 0xb8bda50f, 0x2802b89e, 0x5f058808, 0xc60cd9b2, 0xb10be924,
    0x2f6f7c87, 0x58684c11, 0xc1611dab, 0xb6662d3d, 0x76dc4190, 0x01db7106,
    0x98d220bc, 0xefd5102a, 0x71b18589, 0x06b6b51f, 0x9fbfe4a5, 0xe8b8d433,
    0x7807c9a2, 0x0f00f934, 0x9609a88e, 0xe10e9818, 0x7f6a0dbb, 0x086d3d2d,
    0x91646c97, 0xe6635c01, 0x6b6b51f4, 0x1c6c6162, 0x856530d8, 0xf262004e,
    0x6c0695ed, 0x1b01a57b, 0x8208f4c1, 0xf50fc457, 0x65b0d9c6, 0x12b7e950,
    0x8bbeb8ea, 0xfcb9887c, 0x62dd1ddf, 0x15da2d49, 0x8cd37cf3, 0xfbd44c65,
    0x4db26158, 0x3ab551ce, 0xa3bc0074, 0xd4bb30e2, 0x4adfa541, 0x3dd895d7,
    0xa4d1c46d, 0xd3d6f4fb, 0x4369e96a, 0x346ed9fc, 0xad678846, 0xda60b8d0,
    0x44042d73, 0x33031de5, 0xaa0a4c5f, 0xdd0d7cc9, 0x5005713c, 0x270241aa,
    0xbe0b1010, 0xc90c2086, 0x5768b525, 0x206f85b3, 0xb966d409, 0xce61e49f,
    0x5edef90e, 0x29d9c998, 0xb0d09822, 0xc7d7a8b4, 0x59b33d17, 0x2eb40d81,
    0xb7bd5c3b, 0xc0ba6cad, 0xedb88320, 0x9abfb3b6, 0x03b6e20c, 0x74b1d29a,
    0xead54739, 0x9dd277af, 0x04db2615, 0x73dc1683, 0xe3630b12, 0x94643b84,
    0x0d6d6a3e, 0x7a6a5aa8, 0xe40ecf0b, 0x9309ff9d, 0x0a00ae27, 0x7d079eb1,
    0xf00f9344, 0x8708a3d2, 0x1e01f268, 0x6906c2fe, 0xf762575d, 0x806567cb,
    0x196c3671, 0x6e6b06e7, 0xfed41b76, 0x89d32be0, 0x10da7a5a, 0x67dd4acc,
    0xf9b9df6f, 0x8ebeeff9, 0x17b7be43, 0x60b08ed5, 0xd6d6a3e8, 0xa1d1937e,
    0x38d8c2c4, 0x4fdff252, 0xd1bb67f1, 0xa6bc5767, 0x3fb506dd, 0x48b2364b,
    0xd80d2bda, 0xaf0a1b4c, 0x36034af6, 0x41047a60, 0xdf60efc3, 0xa867df55,
    0x316e8eef, 0x4669be79, 0xcb61b38c, 0xbc66831a, 0x256fd2a0, 0x5268e236,
    0xcc0c7795, 0xbb0b4703, 0x220216b9, 0x5505262f, 0xc5ba3bbe, 0xb2bd0b28,
    0x2bb45a92, 0x5cb36a04, 0xc2d7ffa7, 0xb5d0cf31, 0x2cd99e8b, 0x5bdeae1d,
    0x9b64c2b0, 0xec63f226, 0x756aa39c, 0x026d930a, 0x9c0906a9, 0xeb0e363f,
    0x72076785, 0x05005713, 0x95bf4a82, 0xe2b87a14, 0x7bb12bae, 0x0cb61b38,
    0x92d28e9b, 0xe5d5be0d, 0x7cdcefb7, 0x0bdbdf21, 0x86d3d2d4, 0xf1d4e242,
    0x68ddb3f8, 0x1fda836e, 0x81be16cd, 0xf6b9265b, 0x6fb077e1, 0x18b74777,
    0x88085ae6, 0xff0f6a70, 0x66063bca, 0x11010b5c, 0x8f659eff, 0xf862ae69,
    0x616bffd3, 0x166ccf45, 0xa00ae278, 0xd70dd2ee, 0x4e048354, 0x3903b3c2,
    0xa7672661, 0xd06016f7, 0x4969474d, 0x3e6e77db, 0xaed16a4a, 0xd9d65adc,
    0x40df0b66, 0x37d83bf0, 0xa9bcae53, 0xdebb9ec5, 0x47b2cf7f, 0x30b5ffe9,
    0xbdbdf21c, 0xcabac28a, 0x53b39330, 0x24b4a3a6, 0xbad03605, 0xcdd70693,
    0x54de5729, 0x23d967bf, 0xb3667a2e, 0xc4614ab8, 0x5d681b02, 0x2a6f2b94,
    0xb40bbe37, 0xc30c8ea1, 0x5a05df1b, 0x2d02ef8d
    ];

    var nCrc = g_nCrcTable[(~nCrcSeed) & 0xFF];
    nCrc ^= 0x00FFFFFF;
    var nIndex = (nCrcSeed >>> 8) ^ nCrc;
    nCrc = (nCrc >>> 8) & 0x00FFFFFF;
    nCrc ^= g_nCrcTable[nIndex & 0xFF];
    nIndex = (nCrcSeed >>> 16) ^ nCrc;
    nCrc = (nCrc >>> 8) & 0x00FFFFFF;
    nCrc ^= g_nCrcTable[nIndex & 0xFF];
    nIndex = (nCrcSeed >>> 24) ^ nCrc;
    nCrc = (nCrc >>> 8) &0x00FFFFFF;
    nCrc ^= g_nCrcTable[nIndex & 0xFF];

    for(var i = 0; i < pData.length; i++ )
    {
        nIndex = pData.readUInt8(i) ^ nCrc;
        nCrc = (nCrc >>> 8) & 0x00FFFFFF;
        nCrc ^= g_nCrcTable[nIndex & 0xFF];
    }
    return ~nCrc;
}

//Custom function to trim Discord messages that are too long
function truncate(string, length) {

    if (string.length <= length) {
        return string;
    }
    else {
        return string.slice(0, length - 3) + "...";
    }
 }

//Custom timestamp generator
function getFullTimestamp() {

    date = new Date();
    year = date.getFullYear().toString().padStart(4, '0') + "-";
    month = (date.getMonth()+1).toString().padStart(2, '0') + "-";
    day = date.getDate().toString().padStart(2, '0') + " ";
    hours = date.getHours().toString().padStart(2, '0') + ":";
    minutes = date.getMinutes().toString().padStart(2, '0') + ":";
    seconds = date.getSeconds().toString().padStart(2, '0') + ".";
    millisecs = date.getMilliseconds().toString().padStart(3, '0');

    return year + month + day + hours + minutes + seconds + millisecs;
}

const opcodeTable = {
    0x9ca80f98: "AbortTradeMessage",
    0xc58a446e: "AcceptAuctionResponseMessage",
    0xb131ca17: "AcceptTransactionMessage",
    0x69d3e1d2: "AddItemFailedMessage",
    0x1e8d1356: "AddItemMessage",
    0xab2174b6: "AddMapLocationMessage",
    0x5efe4f1c: "AiDebugString",
    0xa04a3eca: "AppendCommentResponseMessage",
    0xf3f12f2a: "AttributeListMessage",
    0x679e0d00: "AuctionQueryHeadersMessage",
    0xfa500e52: "AuctionQueryHeadersResponseMessage",
    0x6d89d25b: "BadgesResponseMessage",
    0x68a75f0c: "BaselinesMessage",
    0x325932d8: "BeginTradeMessage",
    0xe7491df5: "BeginVerificationMessage",
    0x91125453: "BidAuctionMessage",
    0x8fcbef4a: "BidAuctionResponseMessage",
    0x3687a4d2: "CancelLiveAuctionMessage",
    0x7da2246c: "CancelLiveAuctionResponseMessage",
    0xd6fbf318: "CancelTicketResponseMessage",
    0x9b3a17c4: "CharacterSheetResponseMessage",
    0x6fe7bd90: "ChatAddFriend",
    0xd9fa0194: "ChatBanAvatarFromRoom",
    0x35366bed: "ChatCreateRoom",
    0x772a4b09: "ChatDestroyRoom",
    0xbc6bddf2: "ChatEnterRoomById",
    0x6cd2fcd8: "ChatFriendsListUpdate",
    0x84bb21f7: "ChatInstantMessageToCharacter",
    0x3c565ced: "ChatInstantMessageToClient",
    0xd3ec7372: "ChatInviteAvatarToRoom",
    0x36a03858: "ChatOnAddModeratorToRoom",
    0x5a38538d: "ChatOnBanAvatarFromRoom",
    0xd72fe9be: "ChatOnConnectAvatar",
    0x35d7cc9f: "ChatOnCreateRoom",
    0x4f23965a: "ChatOnDeleteAllPersistentMessages",
    0xe8ec5877: "ChatOnDestroyRoom",
    0xe69bdc0a: "ChatOnEnteredRoom",
    0x493fe74a: "ChatOnInviteToRoom",
    0x60b5098b: "ChatOnLeaveRoom",
    0xc17eb06d: "ChatOnReceiveRoomInvitation",
    0x1342fc47: "ChatOnRemoveModeratorFromRoom",
    0x88dbb381: "ChatOnSendInstantMessage",
    0x94e7a7ae: "ChatOnSendPersistantMessage",
    0xe7b61633: "ChatOnSendRoom",
    0xe7b61633: "ChatOnSendRoomMessage",
    0xbaf9b815: "ChatOnUnbanAvatarFromRoom",
    0xbe33c7e8: "ChatOnUninviteFromRoom",
    0x08485e17: "ChatPersistentMessageToClient",
    0x25a29fa6: "ChatPersistentMessageToServer",
    0x9cf2b192: "ChatQueryRoom",
    0xc4de864e: "ChatQueryRoomResults",
    0x048e3f8a: "ChatRemoveModeratorFromRoom",
    0x4c3d2cfa: "ChatRequestRoomList",
    0x70deb197: "ChatRoomList",
    0xcd4ce444: "ChatRoomMessage",
    0x20e4dbe3: "ChatSendToRoom",
    0x7102b15f: "ChatServerStatus",
    0x6d2a6413: "ChatSystemMessage",
    0xf1018dfc: "ChatUninviteFromRoom",
    0xb97f3074: "ClientCreateCharacter",
    0xdf333c6e: "ClientCreateCharacterFailed",
    0x1db575cc: "ClientCreateCharacterSuccess",
    0xd5899226: "ClientIdMsg",
    0x0f5d5325: "ClientInactivity",
    0x0f5d5325: "ClientInactivityMessage",
    0x2d2d6ee1: "ClientMfdStatusUpdateMessage",
    0x2d2d6ee1: "ClientOpenContainerMessage",
    0xe00730e5: "ClientPermissions",
    0x2d2d6ee1: "ClientPermissionsMessage",
    0xd6d1b6d1: "ClientRandomNameRequest",
    0xe85fb868: "ClientRandomNameResponse",
    0x32b79b7e: "ClosedContainerMessage",
    0xc0938a9d: "CloseHolocronMessage",
    0x43fd1c22: "CmdSceneReady",
    0x3ae6dfae: "CmdStartScene",
    0x48f493c5: "CommoditiesItemTypeListRequest",
    0xd4e937fc: "CommoditiesItemTypeListResponse",
    0x1590f63c: "ConectionServerLagResponse",
    0x08c5fc76: "ConGenericMessage",
    0xb1921ad9: "ConnectionClosed",
    0x3b882f0e: "ConnectionServerConnectionClosed",
    0x3ca2f9a7: "ConnectionServerConnectionOpened",
    0x2e365218: "ConnectPlayer",
    0x2e365218: "ConnectPlayerMessage",
    0x6137556f: "ConnectPlayerResponse",
    0x6137556f: "ConnectPlayerResponseMessage",
    0x99dcb094: "ConsentRequestMessage",
    0x1d0247ad: "CreateAuctionMessage",
    0x0e61cc92: "CreateAuctionResponseMessage",
    0x71957628: "CreateClientPathMessage",
    0x1e9ce308: "CreateImmediateAuctionMessage",
    0x721cf08b: "CreateMissileMessage",
    0x65f27987: "CreateNebulaLightningMessage",
    0xb88af9a5: "CreateProjectileMessage",
    0x550a407a: "CreateTicketResponseMessage",
    0x32cd924b: "CuiControlsMenuBindEntry::Messages::UPDATE_BINDING",
    0xaa867c55: "CuiIoWin::Messages::CONTROL_KEY_DOWN",
    0x81573066: "CuiIoWin::Messages::CONTROL_KEY_UP",
    0x399ec0ea: "CuiIoWin::Messages::POINTER_INPUT_TOGGLED",
    0xe78fb0bf: "CuiLoadingManager::FullscreenLoadingDisabled",
    0x28956a79: "CuiSpatialChatManager::Messages::CHAT_RECEIVED",
    0xd0cdaa62: "DebugTransformMessage",
    0xe87ad031: "DeleteCharacterMessage",
    0x8268989b: "DeleteCharacterReplyMessage",
    0x12862153: "DeltasMessage",
    0x6ec28670: "DenyTradeMessage",
    0xa75e85eb: "DestroyClientPathMessage",
    0x3871d784: "DestroyShipComponentMessage",
    0x5c680884: "DestroyShipMessage",
    0xca2a548b: "DogfightTauntPlayerMessage",
    0x023320d5: "EditAppearanceMessage",
    0x305e8c28: "EditStatsMessage",
    0xe8a54dc1: "EnterStructurePlacementModeMessage",
    0x904dae1a: "EnterTicketPurchaseModeMessage",
    0x65ea4574: "EnumerateCharacterId",
    0xb5abf91a: "ErrorMessage",
    0xb1cfce1c: "ExecuteConsoleCommand",
    0x5dd53957: "FactionResponseMessage",
    0x4e428088: "GalaxyLoopTimesResponse",
    0xbbadaeb9: "Game::SCENE_CHANGED",
    0xb93e9488: "GameConnectionClosed",
    0xbe144221: "GameConnectionOpened",
    0x789a4e0a: "GameServerLagResponse",
    0x5e7b4546: "GetArticleMessage",
    0x934baee0: "GetArticleResponseMessage",
    0xd36efae4: "GetAuctionDetails",
    0xfe0e644b: "GetAuctionDetailsResponse",
    0xeadb08ca: "GetCommentsResponseMessage",
    0x1a7ab839: "GetMapLocationsMessage",
    0x9f80464c: "GetMapLocationsResponseMessage",
    0xbb567f98: "GetTicketsResponseMessage",
    0xd1527ee8: "GiveMoneyMessage",
    0x32263f20: "GuildResponseMessage",
    0xcbf88482: "HyperspaceMessage",
    0x4eb0b06a: "IsFlattenedTheaterMessage",
    0x21b55a3b: "IsVendorMessage",
    0xce04173e: "IsVendorOwnerResponseMessage",
    0xc5ed2f85: "LagReport",
    0x31805ee0: "LagRequest",
    0x8de7e213: "LaunchBrowserMessage",
    0xa16cf9af: "LinkDeadMessage",
    0x41131f96: "LoginClientID",
    0xaab296c6: "LoginClientToken",
    0x3436aeb6: "LoginClusterStatus",
    0xc38256f0: "LoginConnectionClosed",
    0xc4a88059: "LoginConnectionOpened",
    0xc11c63b9: "LoginEnumCluster",
    0x42fd19dd: "LogoutMessage",
    0xca375124: "NewbieTutorialEnableHudElement",
    0x90dd61af: "NewbieTutorialRequest",
    0xca88fbad: "NewbieTutorialResponse",
    0x274f4e78: "NewTicketActivity",
    0x6ea42d80: "NewTicketActivityResponseMessage",
    0x80ce5e46: "ObjControllerMessage",
    0x80ce5e46: "ObjectController",
    0x7ca18726: "ObjectMenuSelectMessage::MESSAGE_TYPE",
    0x2e11e4ab: "OpenedContainerMessage",
    0x7cb65021: "OpenHolocronToPageMessage",
    0x487652da: "ParametersMessage",
    0x52f364b8: "PermissionListCreateMessage",
    0x96405d4d: "PlanetTravelPointListRequest",
    0x4d32541f: "PlanetTravelPointListResponse",
    0x8855434A: "PlayClientEffectLocMessage",
    0x8855434a: "PlayClientEffectObjectMessage",
    0x4f5e09b6: "PlayClientEffectObjectTransformMessage",
    0x0a4e222c: "PlayClientEventLocMessage",
    0xaf83c3f2: "PlayClientEventObjectMessage",
    0x367e737e: "PlayerMoneyResponse",
    0x04270d8a: "PlayMusicMessage",
    0x88d9885c: "PopulateMissionBrowserMessage",
    0x4417af8b: "RemoveItemMessage",
    0xf898e25f: "RequestCategories",
    0x61148fd4: "RequestCategoriesResponseMessage",
    0x8e33ed05: "RequestExtendedClusterInfo",
    0x7d842d68: "RequestGalaxyLoopTimes",
    0xbd18c679: "ResourceHarvesterActivatePageMessage",
    0x8a64b1d5: "ResourceListForSurveyMessage",
    0x12b0d449: "RetrieveAuctionItemMessage",
    0x9499ef8c: "RetrieveAuctionItemResponseMessage",
    0x5f628053: "SaveTextOnClient",
    0xfe89ddea: "SceneCreateObjectByCrc",
    0x4d45d504: "SceneDestroyObject",
    0x2c436037: "SceneEndBaselines",
    0x962e8b9b: "SearchKnowledgeBaseMessage",
    0x7cbc8f67: "SearchKnowledgeBaseResponseMessage",
    0xb5098d76: "SelectCharacter",
    0x2ebc3bd9: "ServerTimeMessage",
    0x486356ea: "ServerWeatherMessage",
    0x763648d0: "ShipUpdateTransformCollisionMessage",
    0x76026fb9: "ShipUpdateTransformMessage",
    0xefac38c4: "StatMigrationTargetsMessage",
    0xad6f6b26: "StopClientEffectObjectByLabelMessage",
    0xd44b7259: "SuiCreatePageMessage",
    0x092d3564: "SuiEventNotification",
    0x990b5de0: "SuiForceClosePage",
    0x5f3342f6: "SuiUpdatePageMessage",
    0x877f79ac: "SurveyMessage",
    0xc542038b: "TradeCompleteMessage",
    0xe81e4382: "UnAcceptTransactionMessage",
    0xf612499c: "UpdateCellPermissionMessage",
    0x56cbde9e: "UpdateContainmentMessage",
    0x1228cd01: "UpdateMissileMessage",
    0x0bde6b41: "UpdatePostureMessage",
    0x08a1c126: "UpdatePvpStatusMessage",
    0x1b24f808: "UpdateTransformMessage",
    0xc867ab5a: "UpdateTransformWithParentMessage",
    0xf4c498fd: "VerifyPlayerNameResponseMessage",
    0x9ae247ee: "VerifyTradeMessage"
};

const opcodeLookup = (opcode) => opcodeTable[opcode] || "NotMapped";

const ignoreTable = {
    0x68a75f0c: "BaselinesMessage",
    0xe8ec5877: "ChatOnDestroyRoom",
    0x12862153: "DeltasMessage",
    0x80ce5e46: "ObjectController",
    0x487652da: "ParametersMessage",
    0x8855434A: "PlayClientEffectLocMessage",
    0x8855434a: "PlayClientEffectObjectMessage",
    0x4f5e09b6: "PlayClientEffectObjectTransformMessage",
    0x0a4e222c: "PlayClientEventLocMessage",
    0xaf83c3f2: "PlayClientEventObjectMessage",
    0xfe89ddea: "SceneCreateObjectByCrc",
    0x4d45d504: "SceneDestroyObject",
    0x2c436037: "SceneEndBaselines",
    0x486356ea: "ServerWeatherMessage",
    0xf612499c: "UpdateCellPermissionMessage",
    0x56cbde9e: "UpdateContainmentMessage",
    0x08a1c126: "UpdatePvpStatusMessage",
    0x1b24f808: "UpdateTransformMessage",
}
