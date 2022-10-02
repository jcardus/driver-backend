const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager')
const client = new SecretsManagerClient({ region: 'us-east-1' })
const _secret = client.send(new GetSecretValueCommand({ SecretId: process.env.TRACCAR_SECRET_NAME })).then(s => JSON.parse(s.SecretString))
const { DynamoDBClient, ScanCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb')
const dynamo = new DynamoDBClient({ region: 'us-east-1' })
const { unmarshall, marshall } = require('@aws-sdk/util-dynamodb')
const axios = require('axios')

exports.getUsers = async (user) => {
  console.log('getting', user.username)
  const _user = await dynamo.send(new GetItemCommand({
    TableName: process.env.DRIVER_USER_TABLE,
    Key: marshall({ id: user.username })
  }))
  user = unmarshall(_user.Item)
  const secret = await _secret
  const users = await axios.get(`${secret.basePath}/users?userId=${user.parentUserId}`, { auth: secret }).then(d => d.data)
  users.push(await axios.get(`${secret.basePath}/users/${user.parentUserId}`, { auth: secret }).then(d => d.data))
  return users
}

exports.get = async (token, user, deviceId) => {
  console.log('get', token, user)
  if (token) {
    const dDevice = await dynamo.send(new ScanCommand({
      TableName: process.env.DEVICES_TABLE,
      FilterExpression: '#token = :token',
      ExpressionAttributeValues: marshall({ ':token': token }, { removeUndefinedValues: true }),
      ExpressionAttributeNames: { '#token': 'token' }
    }))
    console.log(dDevice)
    const d = unmarshall(dDevice.Items[0])
    console.log('device', d)
    deviceId = d.deviceId
  }
  if (token || deviceId) {
    const auth = await _secret
    const axios = require('axios').create({ auth, baseURL: auth.baseUrl })
    const [device] = await axios.get(`devices?id=${deviceId}`).then(d => d.data)
    device.attributes.driverUniqueId = user.username
    await axios.put(`devices/${device.id}`, device)
    const computed = await axios.get('attributes/computed?deviceId=' + device.id).then(d => d.data)
    if (!computed.find(a => a.id === 37)) {
      await axios.post('permissions', { deviceId: device.id, attributeId: 37 })
    }
    return device
  } else {
    console.log('getting', user.username)
    const _user = await dynamo.send(new GetItemCommand({
      TableName: process.env.DRIVER_USER_TABLE,
      Key: marshall({ id: user.username })
    }))
    user = unmarshall(_user.Item)
    const secret = await _secret
    return axios.get(`${secret.basePath}/devices?userId=${user.parentUserId}`, { auth: secret }).then(d => d.data.sort((a, b) => {
      if (a.name > b.name) {
        return 1
      }
      if (a.name < b.name) {
        return -1
      }
      return 0
    }))
  }
}

exports.immobilize = async (device) => {
  const auth = await _secret
  const axios = require('axios').create({ auth, baseURL: auth.baseUrl })
  console.log(await axios.post('commands/send', { deviceId: device.id, type: 'custom', attributes: { data: 'setdigout 1' }, description: 'driver backend' }))
}

exports.mobilize = async (device) => {
  const auth = await _secret
  const axios = require('axios').create({ auth, baseURL: auth.baseUrl })
  await axios.post('commands/send', { deviceId: device.id, type: 'custom', attributes: { data: 'setdigout 0' }, description: 'driver backend' })
}

async function checkOut1 (axios, deviceId, resolve) {
  const [device] = await axios.get('devices?id=' + deviceId).then(d => d.data)
  console.log('checking', device.name)
  const [position] = await axios.get('positions?id=' + device.positionId).then(d => d.data)
  console.log('checking', position.fixTime, position.attributes)
  if (position.attributes.out1) { resolve() } else { setTimeout(checkOut1, 2000, deviceId, resolve) }
}

exports.startTrip = async (device) => {
  const auth = await _secret
  const axios = require('axios').create({ auth, baseURL: auth.baseUrl })
  const data = 'setparam 11700:0'
  console.log('deviceId', device.id, 'sending', data)
  await axios.post('commands/send', { deviceId: device.id, type: 'custom', attributes: { data }, description: 'driver backend' })
  await new Promise((resolve) => checkOut1(axios, device.id, resolve))
}

exports.endTrip = async (item) => {
  const auth = await _secret
  const axios = require('axios').create({ auth, baseURL: auth.baseUrl })
  const [device] = await axios.get('devices?id=' + item.id).then(d => d.data)
  if (device.attributes.driverUniqueId) {
    console.log('Logout driver', device.id, device.attributes.driverUniqueId)
    delete device.attributes.driverUniqueId
    await axios.put('devices/' + device.id, device)
  }
  await axios.post('commands/send', { deviceId: device.id, type: 'custom', attributes: { data: 'setparam 11700:3' }, description: 'driver backend' })
}
