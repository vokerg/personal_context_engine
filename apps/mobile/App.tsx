import { SafeAreaView, Text, View } from 'react-native';

export default function App() {
  return <SafeAreaView style={{ flex: 1, justifyContent: 'center' }}><View style={{ padding: 24 }}><Text style={{ fontSize: 24, fontWeight: 'bold' }}>Personal Context Engine</Text><Text>Mobile scaffold only. No private note access or push delivery.</Text></View></SafeAreaView>;
}
